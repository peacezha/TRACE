// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { loadAgentSettings, normalizeAgentSettings, saveAgentSettings } from './agentSettings';

describe('agent settings', () => {
  beforeEach(() => localStorage.clear());

  it('uses scoped bounded defaults and preserves explicit full access', () => {
    expect(normalizeAgentSettings({ maxCommands: 999, maxSteps: 1 })).toEqual({
      engine: 'auto',
      planningPolicy: 'auto',
      confirmationPolicy: 'dangerous',
      pathPolicy: 'scoped',
      maxCommands: 200,
      maxSteps: 10,
      planReview: 'auto',
    });
    expect(normalizeAgentSettings({ pathPolicy: 'full_access' }).pathPolicy).toBe('full_access');
  });

  it('defaults new installations to a longer 200-step run', () => {
    expect(loadAgentSettings()).toMatchObject({
      maxCommands: 40,
      maxSteps: 200,
    });
  });

  it('migrates the hidden legacy 50-step default without overriding a new explicit 50', () => {
    localStorage.setItem('trace_agent_settings', JSON.stringify({ maxCommands: 40, maxSteps: 50 }));
    expect(loadAgentSettings().maxSteps).toBe(200);

    saveAgentSettings({ maxCommands: 40, maxSteps: 50 });
    expect(loadAgentSettings().maxSteps).toBe(50);
  });

  it('migrates the pre-0.4.57 automatic confirmation default back to dangerous but preserves a new explicit never', () => {
    localStorage.setItem('trace_agent_settings', JSON.stringify({
      version: 4, confirmationPolicy: 'never', maxCommands: 40, maxSteps: 200,
    }));
    expect(loadAgentSettings().confirmationPolicy).toBe('dangerous');

    saveAgentSettings({ confirmationPolicy: 'never' });
    expect(loadAgentSettings().confirmationPolicy).toBe('never');
  });

  it('allows the new upper limits but still clamps oversized values', () => {
    expect(normalizeAgentSettings({ maxCommands: 200, maxSteps: 500 })).toMatchObject({ maxCommands: 200, maxSteps: 500 });
    expect(normalizeAgentSettings({ maxCommands: 201, maxSteps: 501 })).toMatchObject({ maxCommands: 200, maxSteps: 500 });
  });

  it('persists user policy choices', () => {
    saveAgentSettings({ engine: 'native', planningPolicy: 'always', confirmationPolicy: 'never', pathPolicy: 'scoped', maxCommands: 20, maxSteps: 30 });
    expect(loadAgentSettings()).toMatchObject({
      engine: 'native',
      planningPolicy: 'always',
      confirmationPolicy: 'never',
      pathPolicy: 'scoped',
      maxCommands: 20,
      maxSteps: 30,
    });
  });

  it('supports explicitly selecting dsh while rejecting unknown engines', () => {
    expect(normalizeAgentSettings({ engine: 'dsh' }).engine).toBe('dsh');
    expect(normalizeAgentSettings({ engine: 'other' }).engine).toBe('auto');
  });

  it('defaults plan review to auto, accepts always, and rejects unknown values', () => {
    expect(normalizeAgentSettings({}).planReview).toBe('auto');
    expect(normalizeAgentSettings({ planReview: 'always' }).planReview).toBe('always');
    expect(normalizeAgentSettings({ planReview: 'never' }).planReview).toBe('auto');
  });

  it('migrates pre-v6 storage by gaining planReview=auto without touching other choices', () => {
    localStorage.setItem('trace_agent_settings', JSON.stringify({
      version: 5, engine: 'native', planningPolicy: 'always', confirmationPolicy: 'state_changes',
      pathPolicy: 'scoped', maxCommands: 20, maxSteps: 30,
    }));
    expect(loadAgentSettings()).toEqual({
      engine: 'native', planningPolicy: 'always', confirmationPolicy: 'state_changes',
      pathPolicy: 'scoped', maxCommands: 20, maxSteps: 30, planReview: 'auto',
    });
    // v6 存储保留用户主动选择的 always
    saveAgentSettings({ planReview: 'always' });
    expect(loadAgentSettings().planReview).toBe('always');
  });
});
