/** Input errors that can be shown directly in the desktop UI. */
export class DashboardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DashboardInputError';
  }
}
