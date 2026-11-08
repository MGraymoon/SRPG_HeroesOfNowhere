# dev/ — tools for the MZ port

Not part of the game. Exclude this folder (and `.claude/`, `.git/`) when deploying.

## Re-import from the MV project

```bash
node dev/import_mv.js "C:/Users/User/Desktop/Backup/DISCO C/Documents/RPG Maker MV Games/TableTopFun" --no-assets
```

Rebuilds `data/` from the MV database (and `js/plugins.js` parameters), so don't hand-edit
imported data until the port leaves the test phase. Drop `--no-assets` to recopy images/audio.
`dev/import_report.txt` lists what the converter left alone, and skills where the old code and
the `[Livre]` marker in the description disagree.

## Play in a browser

```bash
node dev/server.js 8686
```

Then open `http://localhost:8686/index.html?test`. HoN script errors show in a red box.

## Scripted tests

In the browser console of the running game:

```js
await (await fetch('/dev/test_harness.js')).text().then(eval);
await HT.startBattle();
await HT.select(10, 7);  await HT.choose('Mover');  await HT.confirmAt(10, 9);
HT.state();  await HT.shot('name');   // -> dev/screenshots/name.png
```
