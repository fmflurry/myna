import { toMeetingId } from '../../core/models/meeting.model';
import { computePlacement } from './reorder-placement.util';

/**
 * Pure placement math. `rendered` is the CONTAINER's rendered order as
 * displayed — the backend list and the UI's filtered list are different
 * arrays, which is why this returns neighbour ids rather than an index.
 */
describe('computePlacement', () => {
  it('drops before the first row: previousId null, nextId the current first row', () => {
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c')];

    const result = computePlacement(rendered, toMeetingId('c'), toMeetingId('a'), 'before');

    expect(result).toEqual({ previousId: null, nextId: toMeetingId('a') });
  });

  it('drops after the last row: previousId the current last row, nextId null', () => {
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c')];

    const result = computePlacement(rendered, toMeetingId('a'), toMeetingId('c'), 'after');

    expect(result).toEqual({ previousId: toMeetingId('c'), nextId: null });
  });

  it('drops between two rows: both previousId and nextId are set', () => {
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c'), toMeetingId('d')];

    const result = computePlacement(rendered, toMeetingId('d'), toMeetingId('b'), 'after');

    expect(result).toEqual({ previousId: toMeetingId('b'), nextId: toMeetingId('c') });
  });

  it('strips the dragged id from rendered before slotting, so neighbour lookups never index into the un-stripped array', () => {
    // Layout: x, d(ragged), a, y, b(anchor). Naively indexing the anchor's
    // position in the STRIPPED array but reading neighbours back out of the
    // ORIGINAL (un-stripped) array would wrongly return `a` as previousId
    // instead of `y`. Correct behavior strips first and stays consistent.
    const rendered = [toMeetingId('x'), toMeetingId('d'), toMeetingId('a'), toMeetingId('y'), toMeetingId('b')];

    const result = computePlacement(rendered, toMeetingId('d'), toMeetingId('b'), 'before');

    expect(result).toEqual({ previousId: toMeetingId('y'), nextId: toMeetingId('b') });
  });

  it('returns null when the anchor IS the dragged row', () => {
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c')];

    const result = computePlacement(rendered, toMeetingId('b'), toMeetingId('b'), 'before');

    expect(result).toBeNull();
  });

  it('returns null when the drop resolves to the dragged meeting’s existing slot (no-op self/adjacent drop)', () => {
    // b is currently between a and c; dropping it "before c" resolves to the
    // exact same (a, c) neighbour pair it already has.
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c')];

    const result = computePlacement(rendered, toMeetingId('b'), toMeetingId('c'), 'before');

    expect(result).toBeNull();
  });

  it('returns null when the anchor is absent from rendered (stale, e.g. deleted mid-drag)', () => {
    const rendered = [toMeetingId('a'), toMeetingId('b'), toMeetingId('c')];

    const result = computePlacement(rendered, toMeetingId('a'), toMeetingId('ghost'), 'before');

    expect(result).toBeNull();
  });
});
