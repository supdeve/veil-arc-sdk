import { randomBytes } from 'node:crypto';
import { calculateJwkThumbprint, exportJWK, GeneralEncrypt, generalDecrypt, type GeneralJWE } from 'jose';
import { keccak256, concat, toUtf8Bytes, verifyMessage, type Signer } from 'ethers';
import { address, check, digest } from './agreement.js';

export interface Recipient { wallet:string; key:CryptoKey; binding:string; }
export function privateCommitment(plaintext: string, salt: string): string {
  digest(salt); check(typeof plaintext==='string','INVALID_PAYLOAD');
  return keccak256(concat([salt,toUtf8Bytes(plaintext)]));
}
async function bindingMessage(key: CryptoKey): Promise<string> {
  return 'VEIL_V2_ENCRYPTION_KEY\n'+await calculateJwkThumbprint(await exportJWK(key));
}
export async function bindKey(signer: Signer,key: CryptoKey): Promise<Recipient> {
  return {wallet:address(await signer.getAddress()),key,binding:await signer.signMessage(await bindingMessage(key))};
}
export async function seal(plaintext: string, recipients: Recipient[]): Promise<GeneralJWE> {
  check(typeof plaintext==='string' && Buffer.byteLength(plaintext)<=1_048_576,'INVALID_PAYLOAD');
  check(recipients.length===2 && new Set(recipients.map(r=>address(r.wallet))).size===2,'INVALID_RECIPIENTS');
  const encryption=new GeneralEncrypt(toUtf8Bytes(plaintext)).setProtectedHeader({enc:'A256GCM',typ:'veil-v2+jwe'});
  for (const r of recipients) {
    check(verifyMessage(await bindingMessage(r.key),r.binding)===address(r.wallet),'UNBOUND_ENCRYPTION_KEY');
    encryption.addRecipient(r.key).setUnprotectedHeader({alg:'RSA-OAEP-256',kid:address(r.wallet)});
  }
  return encryption.encrypt();
}
export async function open(envelope: GeneralJWE,key: CryptoKey): Promise<string> {
  const result=await generalDecrypt(envelope,key,{keyManagementAlgorithms:['RSA-OAEP-256'],contentEncryptionAlgorithms:['A256GCM']});
  check(result.protectedHeader?.typ==='veil-v2+jwe','INVALID_ENVELOPE');
  return new TextDecoder('utf-8',{fatal:true}).decode(result.plaintext);
}

/** Reference access service. Stores ciphertext only; callers own all decryption keys.
 * Challenge is single-use and binds the service instance, agreement and expiration.
 * Caller must provision authenticated ACLs with create(); there is no public listing.
 */
export class PayloadStore {
  private records=new Map<string,{owners:string[];envelope:GeneralJWE}>();
  private challenges=new Map<string,{id:string;until:number}>();
  private instance=randomBytes(32).toString('hex');
  constructor(private now=()=>Math.floor(Date.now()/1000)) {}
  create(id:string,recipients:[string,string],envelope:GeneralJWE):void {
    digest(id); check(!this.records.has(id),'DUPLICATE_AGREEMENT');
    const owners=recipients.map(address);
    check(new Set(owners).size===2 && envelope.recipients.length===2,'INVALID_RECIPIENTS');
    check(envelope.recipients.every(r=>owners.includes(String(r.header?.kid)))
      && new Set(envelope.recipients.map(r=>r.header?.kid)).size===2,'INVALID_RECIPIENTS');
    this.records.set(id,{owners,envelope:structuredClone(envelope)});
  }
  challenge(id:string):string {
    digest(id); const until=this.now()+60;
    const message=`VEIL_V2_READ\n${this.instance}\n${id}\n${until}\n${randomBytes(32).toString('hex')}`;
    this.challenges.set(message,{id,until}); return message;
  }
  read(message:string,signature:string):GeneralJWE {
    const request=this.challenges.get(message); this.challenges.delete(message);
    check(request && this.now()<request.until,'INVALID_CHALLENGE');
    let signer=''; try { signer=verifyMessage(message,signature); } catch {}
    const record=this.records.get(request.id);
    check(record && record.owners.includes(signer),'NOT_AUTHORIZED');
    return structuredClone(record.envelope);
  }
}
