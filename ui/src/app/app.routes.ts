import { Routes } from '@angular/router';

import { screenshotCanMatch } from './screenshot/screenshot.guard';

export const routes: Routes = [
  // Dev-only screenshot harness (`?screenshot=<scene>`, see
  // `scripts/capture-screenshots.sh`). Guarded by `screenshotCanMatch` (false
  // in production, so this lazy chunk is never loaded there) and declared
  // before the redirect so it wins when the query param is present.
  {
    path: '',
    canMatch: [screenshotCanMatch],
    loadComponent: () =>
      import('./screenshot/screenshot-host.component').then((m) => m.ScreenshotHostComponent),
  },
  { path: '', pathMatch: 'full', redirectTo: 'meetings' },
  {
    path: 'meetings',
    loadChildren: () => import('./modules/meetings/meetings.routes').then((m) => m.meetingsRoutes),
  },
];
