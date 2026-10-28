import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinWorkflows } from './workflowStore';
import { renderWorkflowCommand, type Workflow } from './workflowTypes';

function hidogWorkflow(id: string): Workflow {
  const workflow = builtinWorkflows().find(item => item.id === id);
  if (!workflow) throw new Error(`missing builtin workflow: ${id}`);
  return workflow;
}

function renderWithDefaults(workflow: Workflow): string[] {
  const values: Record<string, string> = {};
  for (const param of workflow.params) {
    values[param.name] = param.defaultValue ?? `/data/${param.name.toLowerCase()}`;
  }
  return workflow.steps.map(step => {
    for (const param of step.params ?? []) {
      values[param.name] = param.defaultValue ?? `/data/${param.name.toLowerCase()}`;
    }
    return renderWorkflowCommand(step.command, values);
  });
}

describe('HiDOG V11 builtin workflows', () => {
  it('vector-trace only requires the V11 dependencies it actually uses', () => {
    const workflow = hidogWorkflow('builtin-hidog-vector-trace');
    const software = workflow.manifest?.software.map(item => item.name).join(' ') ?? '';
    const paramNames = workflow.params.map(item => item.name);
    const command = workflow.steps.map(item => item.command).join('\n');

    expect(software).not.toMatch(/BWA|SAMtools|pysam/i);
    expect(paramNames).not.toContain('THREADS');
    expect(command).toContain('--guide-manifest');
    expect(command).toContain('--min-sample-anchor-reads');
    expect(workflow.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'hidog/hidogV11_trace_runner.py' }),
      expect.objectContaining({ source: 'hidog/hidogV11_trace_report.py' }),
    ]));
  });

  it('amplicon exposes the V11 input, UMI, and Prime Editing branches', () => {
    const workflow = hidogWorkflow('builtin-hidog-amplicon');
    const paramNames = workflow.params.map(item => item.name);
    const command = workflow.steps.map(item => item.command).join('\n');

    expect(paramNames).toEqual(expect.arrayContaining([
      'INPUT_MODE', 'UMI_MODE', 'GUIDE_SEQ', 'PEGRNA_SPACER_SEQ',
      'PEGRNA_EXTENSION_SEQ', 'PEGRNA_SCAFFOLD_SEQ',
    ]));
    expect(command).toContain('--input-mode "{{INPUT_MODE}}"');
    expect(command).toContain('--umi-mode "{{UMI_MODE}}"');
    expect(command).toContain('--pegrna-extension-seq "{{PEGRNA_EXTENSION_SEQ}}"');
    expect(workflow.steps).toHaveLength(4);
  });

  it('renders every HiDOG command without unresolved placeholders or prose commands', () => {
    for (const id of ['builtin-hidog-vector-trace', 'builtin-hidog-amplicon']) {
      const workflow = hidogWorkflow(id);
      const rendered = renderWithDefaults(workflow);
      for (const command of rendered) {
        expect(command).not.toContain('{{');
        expect(command).not.toContain('；');
        expect(command).not.toMatch(/按 analysis-report|提取编辑效率|提取各样本/);
      }
    }
  });

  it('keeps the exported complete-workflow JSON aligned with the builtins', () => {
    const exported = JSON.parse(
      fs.readFileSync(path.resolve('workflows/workflows.json'), 'utf8'),
    ) as Workflow[];
    const alignedIds = [
      'builtin-hidog-vector-trace', 'builtin-hidog-amplicon',
      // 11 个 ENCODE 内置流程同样要求 dev 库与 builtinWorkflows() 逐字段一致
      'encode-chipseq-tf-dag', 'encode-chipseq-histone', 'encode-rnaseq-bulk', 'encode-atacseq',
      'encode-dnaseseq', 'encode-wgbs', 'encode-hic', 'encode-chiapet', 'encode-mirnaseq',
      'encode-eclip', 'encode-longread-rnaseq',
    ];
    for (const id of alignedIds) {
      const fromStore = hidogWorkflow(id);
      const fromExport = exported.find(item => item.id === id);
      expect(fromExport).toBeDefined();
      expect({ ...fromExport, createdAt: 0, updatedAt: 0 })
        .toEqual({ ...fromStore, createdAt: 0, updatedAt: 0 });
    }
  });
});
