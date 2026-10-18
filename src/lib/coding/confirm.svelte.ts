/**
 * Controller for the shared ConfirmDialog (the countdown delete flow every screen
 * uses): `ask()` fills the dialog and opens it, `fire()` runs the pending action.
 * Pages render the dialog once through `ConfirmHost.svelte`.
 */
export class ConfirmAsk {
  open = $state(false);
  title = $state("");
  detail = $state("");
  /** the destructive action the countdown dialog confirms */
  private run: (() => void) | null = null;

  ask(title: string, detail: string, run: () => void): void {
    this.title = title;
    this.detail = detail;
    this.run = run;
    this.open = true;
  }

  fire(): void {
    const run = this.run;
    this.run = null;
    run?.();
  }
}
