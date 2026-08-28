import type { Routes } from '@angular/router';

import { provideMeetings } from './meetings.providers';

/**
 * Single-window shape: both the default view and a deep-linked meeting both
 * load the same `MeetingsShellPage` (two-pane Mail/Notes-style layout) — the
 * route param only selects which meeting is pre-opened, it never switches to
 * a different page.
 */
export const meetingsRoutes: Routes = [
  {
    path: '',
    providers: [provideMeetings()],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () =>
          import('./presentation/pages/meetings-shell/meetings-shell.page').then(
            (m) => m.MeetingsShellPage,
          ),
      },
      {
        path: 'meeting/:id',
        loadComponent: () =>
          import('./presentation/pages/meetings-shell/meetings-shell.page').then(
            (m) => m.MeetingsShellPage,
          ),
      },
    ],
  },
];
