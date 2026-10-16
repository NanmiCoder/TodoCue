/** WebKit can clear isComposing on the key that accepts an IME candidate. */
export function isCompositionKey(event: { isComposing: boolean; keyCode: number }) {
  return event.isComposing || event.keyCode === 229;
}

export interface QuickSubmission {
  signature: string;
  key: string;
  revision: number;
}

/** Keep retry identity, lock synchronously, and distinguish a newly typed identical draft. */
export class QuickAddRequest {
  private revision = 0;
  private operation: QuickSubmission | null = null;
  private busy = false;

  edited() { this.revision++; }
  begin(payload: object): QuickSubmission | null {
    if (this.busy) return null;
    const signature = JSON.stringify(payload);
    if (this.operation?.signature !== signature) {
      this.operation = { signature, key: crypto.randomUUID(), revision: this.revision };
    }
    this.busy = true;
    return { ...this.operation, revision: this.revision };
  }
  commit(submitted: QuickSubmission) {
    if (this.operation?.key === submitted.key) this.operation = null;
    return submitted.revision === this.revision;
  }
  settle() { this.busy = false; }
}
