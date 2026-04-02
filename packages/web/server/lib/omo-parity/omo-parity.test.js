import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createOmoParityHarness } from './index.js';

const loadFixture = (name) => {
  const fixturePath = path.join(import.meta.dir, 'fixtures', name);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
};

const createTempDirectory = async () => fsPromises.mkdtemp(path.join(os.tmpdir(), 'omo-parity-'));

const createHarness = (baseDirectory) =>
  createOmoParityHarness({
    baseDirectory,
    runtimeID: 'runtime-omo-parity-test',
    instanceID: 'instance-omo-parity-test',
  });

const expectScenarioPass = (result) => {
  const mismatchMessage = result.mismatches.join('\n');
  expect(result.ok, mismatchMessage).toBe(true);
};

describe('omo parity harness', () => {
  it('runs golden planner, delegation, continuation, tool, cancellation, and replay scenarios deterministically', async () => {
    const baseDirectory = await createTempDirectory();
    const harness = createHarness(baseDirectory);

    const fixtureNames = [
      'golden-planner-flow.json',
      'golden-delegation.json',
      'golden-continuation.json',
      'golden-tool-execution.json',
      'golden-cancellation.json',
      'golden-replay-recovery.json',
    ];

    for (const fixtureName of fixtureNames) {
      const result = await harness.runScenario(loadFixture(fixtureName));
      expectScenarioPass(result);
    }
  });

  it('runs golden provider degradation scenario and enforces capability-loss contract', async () => {
    const baseDirectory = await createTempDirectory();
    const harness = createHarness(baseDirectory);

    const fixture = loadFixture('golden-provider-degradation.json');
    const result = await harness.runScenario(fixture);
    expectScenarioPass(result);
    expect(result.actual.negotiation.outcome).toBe('degrade');
    expect(result.actual.negotiation.missingCapabilities).toEqual(['images']);
    expect(result.actual.negotiation.degradedCapabilities).toEqual(['images']);
  });

  it('runs provider regression matrix across LiteLLM, Ollama, and OpenAI-compatible paths', async () => {
    const baseDirectory = await createTempDirectory();
    const harness = createHarness(baseDirectory);

    const fixture = loadFixture('golden-provider-regression-matrix.json');
    const result = await harness.runScenario(fixture);
    expectScenarioPass(result);
    expect(result.actual.providers).toHaveLength(3);
    expect(result.actual.providers.map((provider) => provider.providerID)).toEqual(['litellm', 'ollama', 'openai']);
  });
});
