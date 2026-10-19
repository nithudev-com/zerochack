import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain';
import { z } from 'zod';
import { artifactReceiptSchema, phases, resumeSchema, scopeSchema, securityThread, SecurityWorkflowError, stepResultSchema, uuid, workSteps, type ArtifactReceipt, type SecurityPhase, type SecurityScope, type SecurityWorkflowServices, type SecurityWorkStep } from './contracts.js';

const GraphState = Annotation.Root({
  runId: Annotation<string>(),
  phase: Annotation<SecurityPhase>(),
  artifact: Annotation<ArtifactReceipt | null>(),
  blocked: Annotation<boolean>(),
  blockedStep: Annotation<SecurityWorkStep | null>(),
  blockCode: Annotation<string | null>(),
  candidateDecisionId: Annotation<string | null>(),
  candidatePlan: Annotation<ArtifactReceipt | null>()
});
const recheckSchema = z.object({ recheck: z.literal(true) }).strict();
const recheckSteps = ['plan', 'snapshot', 'candidate', 'verify', 'proposal'] as const;
function assertPrivateExecution() {
  // Installed core1.2.18 recognizes all four names, as well as an inherited
  // traceable context. Empty callbacks alone do not disable its auto-tracer.
  if (['LANGSMITH_TRACING', 'LANGSMITH_TRACING_V2', 'LANGCHAIN_TRACING_V2'].some(name => process.env[name]?.toLowerCase() === 'true') ||
      Boolean(process.env.LANGCHAIN_TRACING) || process.env.LANGCHAIN_VERBOSE?.toLowerCase() === 'true' ||
      LangChainTracer.getTraceableRunTree()?.tracingEnabled === true) throw new SecurityWorkflowError('SECURITY_EXTERNAL_TRACING_DENIED');
}

/** Internal factory; it accepts trusted services, never model-selected executors.
 * Only identifiers/digests/status cross checkpoints. Evidence/source live in the
 * encrypted artifact service, not graph messages or LangChain model objects.
 */
export function createSecurityWorkflow(scopeInput: SecurityScope, checkpointer: BaseCheckpointSaver, services: SecurityWorkflowServices) {
  assertPrivateExecution();
  const scope = Object.freeze(scopeSchema.parse(scopeInput));
  const savedStateSchema = z.object({ runId: z.literal(scope.runId), phase: z.enum(phases), artifact: artifactReceiptSchema.nullable(), blocked: z.boolean(), blockedStep: z.enum(workSteps).nullable(), blockCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/u).nullable(), candidateDecisionId: uuid.nullable(), candidatePlan: artifactReceiptSchema.nullable() }).strict();
  async function candidateAuthority(state: typeof GraphState.State) {
    const id = uuid.parse(state.candidateDecisionId), plan = artifactReceiptSchema.parse(state.candidatePlan);
    if (await services.decision('CANDIDATE', id, plan) !== 'APPROVED') throw new SecurityWorkflowError('SECURITY_DECISION_BINDING_CHANGED');
  }
  async function work(step: SecurityWorkStep, phase: SecurityPhase, state: typeof GraphState.State | null) {
    await services.assertLeaseAndAuthority();
    if (step !== 'plan' && (recheckSteps as readonly string[]).includes(step)) await candidateAuthority(state!);
    await services.transition(phase);
    const previous = state?.artifact ?? null;
    const result = stepResultSchema.parse(await services.step(step, previous ? { previous } : {}));
    await services.assertLeaseAndAuthority();
    if (result.outcome === 'BLOCKED') {
      await services.transition('WAITING_FOR_INPUT', result.code);
      return { phase: 'WAITING_FOR_INPUT' as const, blocked: true, blockedStep: step, blockCode: result.code };
    }
    return { phase, artifact: result.artifact, blocked: false, blockedStep: null, blockCode: null };
  }
  function approval(kind: 'CANDIDATE' | 'PRODUCTION') {
    return async (state: typeof GraphState.State) => {
      // This node restarts on resume. Nothing here before interrupt has effects.
      const artifact = artifactReceiptSchema.parse(state.artifact);
      const answer = interrupt({ kind, runId: scope.runId, artifactId: artifact.artifactId, digest: artifact.digest }, { responseSchema: resumeSchema });
      await services.assertLeaseAndAuthority();
      const decisionId = resumeSchema.parse(answer).decisionId;
      const decision = await services.decision(kind, decisionId, artifact);
      if (decision === 'DENIED') {
        // Persist the terminal intent in a synchronous checkpoint first. The
        // controller then finalizes/fences the authoritative business run.
        return { phase: 'CANCELLED' as const, blocked: true };
      }
      return { blocked: false, ...(kind === 'CANDIDATE' ? { candidateDecisionId: decisionId, candidatePlan: artifact } : {}) };
    };
  }
  const graph = new StateGraph(GraphState)
    .addNode('plan', () => work('plan', 'PLANNING', null))
    .addNode('candidate_wait', async () => { await services.transition('AWAITING_APPROVAL'); return { phase: 'AWAITING_APPROVAL' as const }; })
    .addNode('candidate_approval', approval('CANDIDATE'))
    .addNode('snapshot', state => work('snapshot', 'SNAPSHOTTING', state))
    .addNode('candidate', state => work('candidate', 'CANDIDATE_WORK', state))
    .addNode('verify', state => work('verify', 'VERIFYING', state))
    .addNode('proposal', state => work('proposal', 'READY_FOR_RELEASE', state))
    .addNode('production_wait', async () => { await services.transition('AWAITING_APPROVAL'); return { phase: 'AWAITING_APPROVAL' as const }; })
    .addNode('production_approval', approval('PRODUCTION'))
    .addNode('readiness_wait', async state => {
      // A missing prerequisite is not a failed side effect. Persist a real wait
      // and recheck only the exact pre-production node stored by trusted work().
      // No browser/model-selected goto, executor or changed manifest is accepted.
      if (!state.blockedStep || !(recheckSteps as readonly string[]).includes(state.blockedStep) || !state.blockCode) throw new SecurityWorkflowError('SECURITY_READINESS_NOT_RESUMABLE');
      recheckSchema.parse(interrupt({ kind: 'READINESS', runId: scope.runId, step: state.blockedStep, code: state.blockCode }, { responseSchema: recheckSchema }));
      await services.assertLeaseAndAuthority();
      return { blocked: false };
    })
    .addNode('apply', state => work('apply', 'APPLYING', state))
    .addNode('post_verify', state => work('post_verify', 'POST_VERIFYING', state))
    .addNode('complete', async () => { await services.assertLeaseAndAuthority(); return { phase: 'COMPLETED' as const }; })
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', state => state.blocked ? 'readiness_wait' : 'candidate_wait')
    .addEdge('candidate_wait', 'candidate_approval')
    .addConditionalEdges('candidate_approval', state => state.blocked ? END : 'snapshot')
    .addConditionalEdges('snapshot', state => state.blocked ? 'readiness_wait' : 'candidate')
    .addConditionalEdges('candidate', state => state.blocked ? 'readiness_wait' : 'verify')
    .addConditionalEdges('verify', state => state.blocked ? 'readiness_wait' : 'proposal')
    .addConditionalEdges('proposal', state => state.blocked ? 'readiness_wait' : 'production_wait')
    .addConditionalEdges('readiness_wait', state => {
      if (!state.blockedStep || !(recheckSteps as readonly string[]).includes(state.blockedStep)) throw new SecurityWorkflowError('SECURITY_READINESS_NOT_RESUMABLE');
      return state.blockedStep;
    })
    .addEdge('production_wait', 'production_approval')
    .addConditionalEdges('production_approval', state => state.blocked ? END : 'apply')
    .addConditionalEdges('apply', state => state.blocked ? END : 'post_verify')
    .addConditionalEdges('post_verify', state => state.blocked ? END : 'complete')
    .addEdge('complete', END)
    .compile({ checkpointer });
  const config = { configurable: { thread_id: securityThread(scope) }, recursionLimit: 24, durability: 'sync' as const, callbacks: [] };
  async function guard() { assertPrivateExecution(); await services.assertLeaseAndAuthority(); }
  return {
    async start() {
      await guard();
      if ((await graph.getState(config)).createdAt) throw new SecurityWorkflowError('SECURITY_WORKFLOW_ALREADY_STARTED');
      return graph.invoke({ runId: scope.runId, phase: 'PLANNING', artifact: null, blocked: false, blockedStep: null, blockCode: null, candidateDecisionId: null, candidatePlan: null }, config);
    },
    async resume(value: unknown) {
      await guard();
      const decision = resumeSchema.parse(value);
      const saved = await graph.getState(config);
      if (!saved.next.some(node => node === 'candidate_approval' || node === 'production_approval')) throw new SecurityWorkflowError('SECURITY_WORKFLOW_NOT_WAITING');
      return graph.invoke(new Command({ resume: decision }), config);
    },
    async continueAfterRestart() {
      await guard();
      const saved = await graph.getState(config);
      if (saved.createdAt && saved.next.length === 0) {
        // A synchronous normal-terminal cursor can outlive the process that was
        // about to finalize its business journal. Authenticate/validate it and
        // recheck the fresh lease; return intent only, without invoking a node.
        const state = savedStateSchema.parse(saved.values);
        if (state.phase === 'CANCELLED' || state.phase === 'COMPLETED') { await guard(); return state; }
      }
      if (!saved.createdAt || !saved.next.length || saved.next.some(node => node.endsWith('_approval') || node === 'readiness_wait')) throw new SecurityWorkflowError('SECURITY_WORKFLOW_NOT_RESUMABLE');
      if (saved.next.some(node => node !== 'plan' && (recheckSteps as readonly string[]).includes(node))) await candidateAuthority(saved.values as typeof GraphState.State);
      // Services.step must return a completed journal receipt or refuse uncertain
      // work. LangGraph replay alone is never remote/paid-call retry authority.
      return graph.invoke(null, config);
    },
    async recheckPrerequisites() {
      await guard();
      const saved = await graph.getState(config);
      if (saved.next.length !== 1 || saved.next[0] !== 'readiness_wait') throw new SecurityWorkflowError('SECURITY_READINESS_NOT_RESUMABLE');
      const state = saved.values as typeof GraphState.State;
      if (state.blockedStep !== 'plan') await candidateAuthority(state);
      return graph.invoke(new Command({ resume: { recheck: true } }), config);
    },
    async status() {
      await guard();
      const saved = await graph.getState(config);
      return savedStateSchema.parse(saved.values);
    }
  };
}
