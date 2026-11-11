/**
 * Late-bound hooks between modules (avoids circular imports):
 * the Claude runner and terminal manager register themselves here.
 */
type ProjectHandler = (projectId: number) => Promise<void>;
const projectDeletedHandlers: ProjectHandler[] = [];
const turnFinishedHandlers: ProjectHandler[] = [];

export const hooks = {
  isProjectBusy: (_projectId: number): boolean => false,
  stopProject: async (_projectId: number): Promise<void> => {},
  /** register cleanup for deleted projects (servers, websites …) */
  onProjectDeleted(fn: ProjectHandler): void {
    projectDeletedHandlers.push(fn);
  },
  /** a project is being deleted: its deployed servers and its website go with it */
  projectDeleted: async (projectId: number): Promise<void> => {
    for (const fn of projectDeletedHandlers) await fn(projectId).catch(() => {});
  },
  /** register work for the end of an AI turn (after its checkpoint) */
  onTurnFinished(fn: ProjectHandler): void {
    turnFinishedHandlers.push(fn);
  },
  /** an AI turn ended in this project */
  turnFinished: (projectId: number): void => {
    for (const fn of turnFinishedHandlers) void fn(projectId).catch(() => {});
  },
};
