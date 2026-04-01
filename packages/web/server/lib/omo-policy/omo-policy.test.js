import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  OMO_POLICY_ACTION,
  buildHandoffSummary,
  createOmoPolicyEngine,
} from './index.js';

const FIXED_ISO = '2026-04-02T06:00:00.000Z';

const loadFixture = (name) => {
  const fixturePath = path.join(import.meta.dir, 'fixtures', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
};

describe('omo policy engine', () => {
  it('golden scenario 1: creates deterministic task graph and delegation actions', () => {
    const fixture = loadFixture('golden-plan-delegation.json');
    const engine = createOmoPolicyEngine({ now: () => FIXED_ISO });

    const planDecision = engine.decideNextAction(fixture.planInput);
    expect(planDecision.action).toBe(OMO_POLICY_ACTION.CREATE_PLAN);
    expect(planDecision.taskGraph.graphID).toBe(fixture.expected.taskGraph.graphID);
    expect(
      planDecision.taskGraph.steps.map((step) => ({
        stepID: step.stepID,
        role: step.role,
        title: step.title,
      }))
    ).toEqual(fixture.expected.taskGraph.steps);

    const delegationDecisions = fixture.delegationInputs.map((input) => engine.decideNextAction(input));
    expect(delegationDecisions).toHaveLength(3);
    expect(
      delegationDecisions.map((decision) => ({
        delegationID: decision.delegation.delegationID,
        taskID: decision.delegation.taskID,
        targetRole: decision.delegation.targetRole,
      }))
    ).toEqual(fixture.expected.delegations);
  });

  it('golden scenario 2: stop-condition guardrail blocks continuation deterministically', () => {
    const fixture = loadFixture('golden-stop-condition.json');
    const engine = createOmoPolicyEngine({ now: () => FIXED_ISO });

    for (let index = 0; index < 5; index += 1) {
      const decision = engine.decideNextAction(fixture.input);
      expect(decision.action).toBe(fixture.expected.action);
      expect(decision.stopReason).toBe(fixture.expected.stopReason);
      expect(decision.action).toBe(OMO_POLICY_ACTION.STOP_LOOP);
    }
  });

  it('golden scenario 3: handoff summary shape is deterministic from fixture', () => {
    const fixture = loadFixture('golden-handoff-summary.json');
    const engine = createOmoPolicyEngine({ now: () => FIXED_ISO });

    const decision = engine.decideNextAction(fixture.input);
    expect(decision.action).toBe(OMO_POLICY_ACTION.EMIT_HANDOFF);
    expect(decision.handoffSummary).toEqual({
      ...fixture.expected,
      createdAt: FIXED_ISO,
    });

    // Keep direct helper behavior aligned with engine output.
    const helperSummary = buildHandoffSummary({
      taskState: fixture.input.taskState,
      recentEvents: fixture.input.recentRuntimeEvents,
      now: () => FIXED_ISO,
    });
    expect(helperSummary).toEqual(decision.handoffSummary);
  });
});
