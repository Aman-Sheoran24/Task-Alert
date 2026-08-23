'use strict';

/* Boot
   Runs last, once every renderer it calls has been defined. */
// ─── Boot ─────────────────────────────────────────────────────────────────────
applyLogCollapsed();
renderIdeas();
renderDocsList();
renderKeyState();
render();
taskInput.focus();
