import { getAddress, isHexString, keccak256, toUtf8Bytes, verifyMessage } from 'ethers';

export const STATUSES = ['PROPOSED','ACCEPTED','FUNDED','SUBMITTED','VERIFIED','SETTLED',
  'REJECTED','EXPIRED','REFUNDED','DISPUTED','FAILED'] as const;
export type Status = typeof STATUSES[number];
export class VeilError extends Error { constructor(public code: string) { super(code); } }
export function check(ok: unknown, code: string): asserts ok { if (!ok) throw new VeilError(code); }
export function digest(value: unknown): asserts value is string {
  check(typeof value === 'string' && isHexString(value,32) && !/^0x0{64}$/.test(value), 'INVALID_COMMITMENT');
}
export function address(value: string): string {
  try { const a=getAddress(value); check(!/^0x0{40}$/i.test(a),'ZERO_ADDRESS'); return a; }
  catch { throw new VeilError('INVALID_ADDRESS'); }
}
export function units(value: string): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value),'INVALID_USDC_DECIMALS');
  const [whole, fraction='']=value.split('.');
  const n=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
  check(n>0n && n < (1n<<256n),'INVALID_AMOUNT'); return n;
}
export function nativeUnits(micro: bigint): bigint {
  check(typeof micro==='bigint' && micro>=0n && micro < (1n<<256n)/1_000_000_000_000n,'INVALID_AMOUNT');
  return micro*1_000_000_000_000n;
}
export interface Terms {
  id: string; buyerAgent: string; sellerAgent: string;
  buyerKey: string; sellerKey: string; amount: string;
  chainId: number; asset: string; escrow: string;
  payloadCommitment: string; deliverableCommitment: string;
  verificationPolicy: {kind:'DIGEST_AND_ATTESTATION'; verifier: string};
  deadline: number; verificationDeadline: number;
  refundConditions: 'NO_SUBMISSION_OR_REVIEW_TIMEOUT_OR_VERIFIER_FAILURE';
}
export function validateTerms(input: Terms): Terms {
  check(input && typeof input==='object','INVALID_TERMS');
  digest(input.id); digest(input.payloadCommitment); digest(input.deliverableCommitment);
  check([31337,5042002].includes(input.chainId),'UNSUPPORTED_NETWORK');
  check(typeof input.amount==='string' && /^[1-9][0-9]*$/.test(input.amount)
    && BigInt(input.amount)<(1n<<256n),'INVALID_AMOUNT');
  for (const n of [input.buyerAgent,input.sellerAgent])
    check(typeof n==='string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(n),'INVALID_AGENT_ID');
  check(input.buyerAgent!==input.sellerAgent,'SAME_AGENT');
  const buyerKey=address(input.buyerKey),sellerKey=address(input.sellerKey);
  const verifier=address(input.verificationPolicy?.verifier);
  check(buyerKey!==sellerKey && verifier!==sellerKey,'INVALID_PARTICIPANTS');
  check(input.verificationPolicy.kind==='DIGEST_AND_ATTESTATION','UNSUPPORTED_POLICY');
  check(Number.isSafeInteger(input.deadline) && input.deadline>0
    && Number.isSafeInteger(input.verificationDeadline) && input.verificationDeadline>input.deadline,'INVALID_DEADLINE');
  check(input.refundConditions==='NO_SUBMISSION_OR_REVIEW_TIMEOUT_OR_VERIFIER_FAILURE','UNSUPPORTED_REFUND');
  return {id:input.id.toLowerCase(),buyerAgent:input.buyerAgent,sellerAgent:input.sellerAgent,
    buyerKey,sellerKey,amount:input.amount,chainId:input.chainId,asset:address(input.asset),escrow:address(input.escrow),
    payloadCommitment:input.payloadCommitment.toLowerCase(),deliverableCommitment:input.deliverableCommitment.toLowerCase(),
    verificationPolicy:{kind:'DIGEST_AND_ATTESTATION',verifier},deadline:input.deadline,
    verificationDeadline:input.verificationDeadline,refundConditions:input.refundConditions};
}
export function commitment(t: Terms): string {
  return keccak256(toUtf8Bytes('VEIL_V2_PRIVATE_TERMS\n'+JSON.stringify(validateTerms(t))));
}
export function acceptanceMessage(t: Terms): string { return 'VEIL_V2_ACCEPT\n'+commitment(t); }
export interface ChainSnapshot { terms: Terms; status: Status; termsHash: string; }
const LEGAL: Record<Status, readonly Status[]> = {
  PROPOSED:['ACCEPTED','REJECTED','EXPIRED'], ACCEPTED:['FUNDED','EXPIRED'],
  FUNDED:['SUBMITTED','REFUNDED'], SUBMITTED:['VERIFIED','FAILED','DISPUTED','REFUNDED'],
  VERIFIED:['SETTLED'], DISPUTED:['REFUNDED'], FAILED:['REFUNDED'],
  SETTLED:[],REJECTED:[],EXPIRED:[],REFUNDED:[]
};
export function legalTransition(from: Status,to: Status): boolean { return from===to || LEGAL[from].includes(to); }

/// In-memory coordinator. Financial truth comes only from its configured chain reader.
/// Refresh may skip intermediate blocks, but never invents receipts or token balances.
export class AgreementEngine {
  readonly terms: Terms;
  private current: Status='PROPOSED';
  private accepted=false;
  constructor(t: Terms, private reader: ()=>Promise<ChainSnapshot>, private now=()=>Math.floor(Date.now()/1000)) {
    this.terms=Object.freeze(validateTerms(t));
    Object.freeze(this.terms.verificationPolicy);
    check(this.now()<t.deadline,'EXPIRED');
  }
  get status(): Status { return this.current; }
  accept(signature: string): void {
    check(this.current==='PROPOSED' && !this.accepted,'REPLAY');
    check(this.now()<this.terms.deadline,'EXPIRED');
    let recovered=''; try { recovered=verifyMessage(acceptanceMessage(this.terms),signature); } catch {}
    check(recovered===this.terms.sellerKey,'UNAUTHORIZED_ACCEPTANCE');
    this.accepted=true; this.current='ACCEPTED';
  }
  async refresh(): Promise<Status> {
    const snapshot=await this.reader();
    check(commitment(snapshot.terms)===commitment(this.terms),'CHAIN_TERMS_MISMATCH');
    digest(snapshot.termsHash);
    check(STATUSES.includes(snapshot.status),'INVALID_CHAIN_STATUS');
    // Only advance to reachable states (or remain unchanged). Never downgrade a confirmed state.
    const reachable=(from: Status,target: Status): boolean => from===target || LEGAL[from].some(s=>reachable(s,target));
    check(reachable(this.current,snapshot.status),'CHAIN_STATE_REGRESSION');
    this.current=snapshot.status; return this.current;
  }
}
