// Undo/redo by whole-state snapshots. A transaction groups many small changes
// (a drag, a slider scrub) into one undo step, and can be nested.

export class History {
  constructor(state, { limit = 200 } = {}) {
    this.state = state;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(reason) {
    for (const listener of this.listeners) listener(this.state, reason);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  get undoLabel() {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel() {
    return this.redoStack.at(-1)?.label ?? null;
  }

  push(label, before) {
    this.undoStack.push({ label, before });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  // Apply one change as its own undo step (or as part of the open transaction).
  commit(label, mutate) {
    if (this.tx) {
      const result = mutate(this.state);
      this.tx.dirty = true;
      this.emit('change');
      return result;
    }
    const before = structuredClone(this.state);
    let result;
    try {
      result = mutate(this.state);
    } catch (error) {
      this.state = before;
      throw error;
    }
    this.push(label, before);
    this.emit('change');
    return result;
  }

  begin(label) {
    if (this.tx) {
      this.tx.depth += 1;
      return;
    }
    this.tx = { label, before: structuredClone(this.state), depth: 1, dirty: false };
  }

  // Inside a transaction: throw away what the transaction did so far and apply
  // `mutate` to the state as it was at begin(). Drags use this so every pointer
  // move is computed from the drag origin instead of accumulating.
  replace(mutate) {
    if (!this.tx) throw new Error('replace() needs an open transaction');
    this.state = structuredClone(this.tx.before);
    const result = mutate(this.state);
    this.tx.dirty = true;
    this.emit('change');
    return result;
  }

  end() {
    if (!this.tx) return;
    this.tx.depth -= 1;
    if (this.tx.depth > 0) return;
    const { label, before, dirty } = this.tx;
    this.tx = null;
    if (dirty) {
      this.push(label, before);
      this.emit('change');
    }
  }

  cancel() {
    if (!this.tx) return;
    this.state = this.tx.before;
    this.tx = null;
    this.emit('change');
  }

  undo() {
    if (this.tx || !this.canUndo) return false;
    const entry = this.undoStack.pop();
    this.redoStack.push({ label: entry.label, before: this.state });
    this.state = entry.before;
    this.emit('undo');
    return true;
  }

  redo() {
    if (this.tx || !this.canRedo) return false;
    const entry = this.redoStack.pop();
    this.undoStack.push({ label: entry.label, before: this.state });
    this.state = entry.before;
    this.emit('redo');
    return true;
  }

  // Replace the whole document (project load); clears the stacks.
  reset(state) {
    this.state = state;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.tx = null;
    this.emit('reset');
  }
}
