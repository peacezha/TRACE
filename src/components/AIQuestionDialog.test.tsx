// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AIQuestionDialog from './AIQuestionDialog';
afterEach(cleanup);
function fixture(extra = {}) {
  const onReply = vi.fn(async () => {}), onDefer = vi.fn();
  const props = { question: { key: 'q', id: 'q', question: 'Choose an input assembly.', options: [{ label: 'IWGSC RefSeq v1.0', description: 'Keep the assembly version unchanged.' }], multiSelect: false },
    open: true, english: true, busy: false, error: '', count: 1, onReply, onDefer, ...extra };
  const view = render(<AIQuestionDialog {...props} />);
  return { ...view, props, onReply, onDefer };
}
describe('question modal', () => {
  it('lets the user request an explanation without confirming the selected option', () => {
    const f = fixture();
    fireEvent.click(screen.getByRole('button', { name: /IWGSC RefSeq/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Explain options first' }));
    expect(f.onReply).toHaveBeenCalledWith({ selected: [], custom: expect.stringContaining('explain'), intent: 'clarification' });
  });
  it('renders in English with explicit submission and preserves scientific identifiers verbatim', async () => {
    const f = fixture();
    expect(screen.getByRole('dialog', { name: 'The agent needs your answer' })).toHaveAttribute('aria-modal', 'false');
    expect(screen.getByRole('button', { name: /IWGSC RefSeq v1.0/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Submit answer' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /IWGSC RefSeq v1.0/ }));
    expect(f.onReply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(f.onReply).toHaveBeenCalledExactlyOnceWith({ selected: ['IWGSC RefSeq v1.0'] }));
  });
  it('supports a free-text-only question, with no fabricated recommendations', () => {
    const f = fixture({ question: { key: 'q', id: 'q', question: 'Enter an absolute path.', options: [], multiSelect: false } });
    fireEvent.change(screen.getByLabelText('Your answer / additional details'), { target: { value: '/data/sample_R1.fastq.gz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(f.onReply).toHaveBeenCalledWith({ selected: [], custom: '/data/sample_R1.fastq.gz' });
    expect(screen.queryByText('Use recommended option')).toBeNull();
  });
  it('treats Escape as "answer later" without cancelling or submitting, and traps Tab focus in the visible dialog', () => {
    const f = fixture(); const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(f.onReply).not.toHaveBeenCalled(); expect(f.onDefer).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: 'Tab' }); expect(screen.getByRole('button', { name: /IWGSC/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: /IWGSC/ }), { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Cancel question' })).toHaveFocus();
  });
  it('ignores Escape while the answer is being delivered, matching the disabled defer button', () => {
    const f = fixture({ busy: true }); const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(f.onDefer).not.toHaveBeenCalled(); expect(f.onReply).not.toHaveBeenCalled();
  });
  it('retains a typed draft while deferred and keeps delivery failures visible', () => {
    const f = fixture();
    fireEvent.change(screen.getByLabelText('Your answer / additional details'), { target: { value: 'Keep reference' } });
    f.rerender(<AIQuestionDialog {...f.props} open={false} />); expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(<AIQuestionDialog {...f.props} error="Delivery unverified" />);
    expect(screen.getByLabelText('Your answer / additional details')).toHaveValue('Keep reference');
    expect(screen.getByRole('alert')).toHaveTextContent('Delivery unverified');
  });
  it('restores a deferred composer answer after an unverified delivery', () => {
    const f = fixture({ open: false });
    const question = { ...f.props.question, draft: { selected: [], custom: '/data/retained_R1.fastq.gz' } };
    f.rerender(<AIQuestionDialog {...f.props} question={question} error="Delivery unverified" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    f.rerender(<AIQuestionDialog {...f.props} question={question} open error="Delivery unverified" />);
    expect(screen.getByLabelText('Your answer / additional details')).toHaveValue('/data/retained_R1.fastq.gz');
    expect(screen.getByRole('alert')).toHaveTextContent('Delivery unverified');
  });
});
