import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'meetings' },
  {
    path: 'meetings',
    loadChildren: () => import('./modules/meetings/meetings.routes').then((m) => m.meetingsRoutes),
  },
];
