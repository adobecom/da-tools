import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActivityLog, ProgressBar } from '../src/components/Activity';

describe('Activity UI', () => {
  it('renders a determinate bar with counts and counters', () => {
    const html = renderToStaticMarkup(
      <ProgressBar label="Updating copy" done={50} total={200} counters={[{ label: 'Updated', value: 48, tone: 'green' }, { label: 'Failed', value: 2, tone: 'red' }]} />,
    );
    expect(html).toContain('Updating copy');
    expect(html).toContain('50 / 200 · 25%');
    expect(html).toContain('width:25%');
    expect(html).toContain('Updated 48');
    expect(html).toContain('Failed 2');
  });

  it('renders an indeterminate bar while the total is unknown', () => {
    const html = renderToStaticMarkup(<ProgressBar label="Discovering documents" done={120} total={0} />);
    expect(html).toContain('120 found');
    expect(html).toContain('animate-pulse');
  });

  it('renders log lines with levels, and nothing when empty', () => {
    expect(renderToStaticMarkup(<ActivityLog lines={[]} onClear={() => {}} />)).toBe('');
    const html = renderToStaticMarkup(
      <ActivityLog lines={[{ time: 0, level: 'error', msg: 'Different wording: /a.html' }]} onClear={() => {}} />,
    );
    expect(html).toContain('Activity log (1)');
    expect(html).toContain('text-red-400');
    expect(html).toContain('Different wording: /a.html');
  });
});
