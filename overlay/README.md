# Screen pen

Lets you draw over your whole screen and any app while sharing in the FYP streaming lab.

`npm start` (from the project root) starts it together with the server on a Mac or Windows PC. Using a deployed server instead? Run `npm run overlay` on the computer you present from.

Share your **Entire screen** in the meeting page and it appears; stop sharing and it disappears. Use the page's ✏️ button or the toolbar at the right edge of your screen. Cmd/Ctrl+Shift+D toggles the pen, Esc stops it.

Everything you draw is sent to the meeting page (over `ws://127.0.0.1:47321`, this machine only), which shows it to everyone, so pause, undo and clear work the same as drawing in the page. Primary display only.
