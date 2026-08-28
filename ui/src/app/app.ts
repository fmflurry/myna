import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Root component. The single-window app shell (title bar, two-pane layout)
 * is owned entirely by the meetings module's routed page — no wrapping
 * nav shell here, no other feature code, no business logic.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {}
