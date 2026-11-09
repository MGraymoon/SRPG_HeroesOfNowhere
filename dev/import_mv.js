// =============================================================================
// dev/import_mv.js — imports the Heroes of Nowhere MV project into this MZ project.
//
//   node dev/import_mv.js "<path to MV project>" [--no-assets]
//
// What it does:
//   1. Copies the MV database (actors, classes, skills, states, items, ...) and
//      adds the fields MZ expects.
//   2. Converts old Yanfly / SRPG_ActionTypes skill notes into HoN tags where the
//      pattern is mechanical, and writes a report of what it left alone.
//   3. Merges MV System.json into MZ's (keeps MZ-only fields).
//   4. Builds the test map (MV Map004 "B1 - Rota da Floresta") with Gear events.
//   5. Copies images and .ogg audio (unless --no-assets).
//   6. Sets Gear + HoN plugin parameters in js/plugins.js.
//
// Re-runnable: it always rebuilds from the MV source, so don't hand-edit the
// imported data files until the port moves past the test phase.
// =============================================================================
"use strict";
const fs = require("fs");
const path = require("path");

const MV = process.argv[2];
const MZ = path.resolve(__dirname, "..");
const COPY_ASSETS = !process.argv.includes("--no-assets");
if (!MV || !fs.existsSync(path.join(MV, "data", "System.json"))) {
  console.error('Usage: node dev/import_mv.js "<MV project folder>" [--no-assets]');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 0));
const mvData = (f) => readJson(path.join(MV, "data", f));
const mzDataPath = (f) => path.join(MZ, "data", f);

const TEST_MAP_ID = 4;
const TEST_PARTY = [32, 4, 1, 19, 36]; // Fang, Nith, Elise, Sieglinde, Senka (summon + auras)
const MOVE_SKILL_ID = 501;
// PvP test: MV's arena (Map014), two teams of four.
const PVP_MAP_ID = 14;
const PVP_SWITCH = 7, DEATHMATCH_SWITCH = 92, LIVES_VAR = 95, RED_WINS = 93, BLUE_WINS = 94;
const PVP_TEAMS = {
  blue: { actors: [1, 32, 4, 19], cells: [[9, 18], [10, 18], [11, 18], [12, 18]], dir: 8 },
  red: { actors: [36, 3, 6, 10], cells: [[9, 3], [10, 3], [11, 3], [12, 3]], dir: 2 },
};
const report = [];

// -----------------------------------------------------------------------------
// 1. Database
// -----------------------------------------------------------------------------
const DB_FILES = ["Actors", "Classes", "Items", "Weapons", "Armors", "Enemies",
  "Animations", "Tilesets", "CommonEvents", "Troops"];
// Yanfly AutoPassiveStates tag on actors, classes, equipment, enemies.
const convertPassiveTag = (note) => note.replace(/<Passive State:\s*([^>]+)>/gi, (m, list) => `<passiveState:${list.trim()}>`);
// -----------------------------------------------------------------------------
// Super Retro World look (sprites built by dev/build_srw_sprites.py)
// -----------------------------------------------------------------------------
// Heroes: actor id -> SRW sprite and motions.
const SRW_ACTORS = {
  1: { sprite: "flame_witch", attack: "sword02", cast: "staff02" },    // Elise: rapier, fire staff
  32: { sprite: "scarf_brawler", attack: "slash01", cast: "staff05" }, // Fang: open-palm strikes, white ki
  4: { sprite: "azure_elf", attack: "spear01", cast: "staff03" },      // Nith: thrust, blue staff
  19: { sprite: "crimson_blade", attack: "spear02", cast: "staff06" }, // Sieglinde: lance, gold staff
};
// New enemies made from an existing one: copies its stats, gets an SRW sprite,
// and replaces it on the test map.
const SRW_ENEMIES = [
  { name: "Bandido", from: 10, sprite: "bandit", attack: "slash01", cast: "staff01" }, // from Bárbaro
];
const srwTags = (u) => `<fieldSprite: ${u.sprite}>\n<attackMotion: ${u.attack}>\n<castMotion: ${u.cast}>`;
const replaceEnemyOnMap = {}; // old enemy id -> new enemy id

function applySrwLook(file, data) {
  if (file === "Actors") {
    for (const [id, u] of Object.entries(SRW_ACTORS)) {
      const a = data[id];
      a.characterName = `$hon_${u.sprite}`;
      a.characterIndex = 0;
      a.note = (a.note ? a.note + "\n" : "") + srwTags(u);
    }
  }
  if (file === "Enemies") {
    for (const u of SRW_ENEMIES) {
      const e = JSON.parse(JSON.stringify(data[u.from]));
      e.id = data.length;
      e.name = u.name;
      e.note = e.note.replace(/<characterName:[^>]*>/i, "").replace(/<characterIndex:[^>]*>/i, "")
        + `\n<characterName:$hon_${u.sprite}>\n<characterIndex:0>\n` + srwTags(u);
      data.push(e);
      replaceEnemyOnMap[u.from] = e.id;
    }
  }
}

for (const f of DB_FILES) {
  const data = mvData(f + ".json");
  if (["Actors", "Classes", "Weapons", "Armors", "Enemies"].includes(f)) {
    data.forEach((o) => { if (o && o.note) o.note = convertPassiveTag(o.note); });
  }
  applySrwLook(f, data);
  writeJson(mzDataPath(f + ".json"), data);
}

// -----------------------------------------------------------------------------
// 1b. State conversion (Yanfly BuffsStatesCore / StateCategories / AutoPassive /
//     StateProtection / QuasiParams -> HoN_States)
// -----------------------------------------------------------------------------
const STATE_EVENTS = {
  "apply": "add", "remove": "remove", "leave": "expire", "turn start": "turnStart", "turn end": "turnEnd",
  "select": "targeted", "deselect": "targetedEnd", "react": "takeDamage", "respond": "afterTakeDamage",
  "initiate": "useStart", "confirm": "dealDamage", "establish": "afterDealDamage", "conclude": "useEnd",
  "action start": "actionStart", "action end": "actionEnd", "battle": "battleStart",
};
const BASE_PARAM = { mhp: "MHP", mmp: "MMP", atk: "ATK", def: "DEF", mat: "MAT", mdf: "MDF", agi: "AGI", luk: "LUK" };

function convertState(st) {
  const out = [];
  const blocks = {}; // event -> code
  let passiveCode = null;
  const rest = [];
  // Line by line, exactly like Yanfly's parser (so malformed blocks behave as they did in MV).
  let mode = null;
  for (const line of st.note.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^\s*<Custom (.+?) Effect>\s*$/i))) {
      const ev = STATE_EVENTS[m[1].toLowerCase()];
      if (ev) { mode = ev; blocks[ev] = blocks[ev] || ""; }
      else { mode = "__ignored"; report.push(`state ${st.id} ${st.name}: <Custom ${m[1]} Effect> was never a Yanfly event (MV ignored it); left out`); }
      continue;
    }
    if (/^\s*<\/Custom .+? Effect>\s*$/i.test(line)) { mode = null; continue; }
    if (/^\s*<Custom Passive Condition>\s*$/i.test(line)) { mode = "__passive"; passiveCode = ""; continue; }
    if (/^\s*<\/Custom Passive Condition>\s*$/i.test(line)) { mode = null; continue; }
    if (mode === "__ignored") continue;
    if (mode === "__passive") { passiveCode += line + "\n"; continue; }
    if (mode) { blocks[mode] += line + "\n"; continue; }
    rest.push(line);
  }
  if (/<Custom .+? Effect>[\s\S]*<Custom .+? Effect>/i.test(st.note) &&
      (st.note.match(/<Custom /gi) || []).length !== (st.note.match(/<\/Custom /gi) || []).length) {
    report.push(`state ${st.id} ${st.name}: a <Custom ... Effect> block was opened but not closed (converted as MV read it)`);
  }
  let note = rest.join("\n");

  // categories -> tags
  const tags = [];
  note = note.replace(/<Category:\s*([^>]+)>/gi, (m, c) => {
    c = c.trim();
    if (/^bypass death removal$/i.test(c)) out.push("<keepOnDeath>");
    else tags.push(c);
    return "";
  });
  if (tags.length) out.push(`<tags: ${[...new Set(tags)].join(", ")}>`);

  // movement from the state's counter
  note = note.replace(/<srpgMovePlus:\s*counter\s*>/gi, () => { out.push("<moveBonus: counter>"); return ""; });

  // YEP BaseParamControl "<atk Plus: -1>" -> params lines
  const extraParams = [];
  note = note.replace(/<(mhp|mmp|atk|def|mat|mdf|agi|luk) Plus:\s*([^>]+)>/gi, (m, p, v) => {
    extraParams.push(`${BASE_PARAM[p.toLowerCase()]}: ${v.trim()}`);
    return "";
  });
  if (extraParams.length) {
    if (/<params>/i.test(note)) note = note.replace(/<\/params>/i, extraParams.join("\n") + "\n</params>");
    else note += "\n<params>\n" + extraParams.join("\n") + "\n</params>";
  }

  // YEP StateProtection guts -> survive
  const guts = note.match(/<HP Protection:\s*(True )?Guts(\d*)\s*\d+%>/i);
  if (guts) {
    if (guts[2]) report.push(`state ${st.id} ${st.name}: "Guts${guts[2]}" was not a Yanfly keyword, so it never worked in MV; converted to <survive>`);
    const once = /<HP Protection:\s*Trigger Removal/i.test(note);
    out.push(once ? "<survive:once>" : "<survive>");
  }
  note = note.replace(/<HP Protection:[^>]*>/gi, "");

  // YEP simple passive conditions
  const simple = note.match(/<Passive Condition:\s*HP (Above|Below)\s*(\d+)(%?)>/i);
  if (simple) {
    const n = Number(simple[2]);
    const lhs = simple[3] ? "a.hpRate() * 100" : "a.hp";
    passiveCode = (passiveCode || "") + `if (!(${lhs} ${simple[1].toLowerCase() === "above" ? ">" : "<"} ${n})) return false;\n`;
    note = note.replace(/<Passive Condition:[^>]*>/gi, "");
  }

  // misc
  note = note.replace(/<hide Turns>/gi, "");
  note = note.replace(/<srpgCounterSkill:\s*(\d+)>/gi, (m, n) => `<srpgReactionSkill:${n}>`);
  if (/<Regen Formula:/i.test(note)) report.push(`state ${st.id} ${st.name}: <Regen Formula> came from a plugin that wasn't installed in MV; left as is`);
  for (const t of ["State Animation", "State Motion", "Weapon Image", "Weapon Motion", "Weapon Animation"]) {
    if (new RegExp("<" + t, "i").test(note)) { report.push(`state ${st.id} ${st.name}: <${t}> kept (visual, not ported yet)`); break; }
  }

  // scripts
  for (const [ev, code] of Object.entries(blocks)) {
    if (code.trim()) out.push(`<script:${ev}>\n${code.trim()}\n</script>`);
  }
  if (passiveCode !== null) {
    const body = /\bcondition\b/.test(passiveCode)
      ? `var condition = true;\n${passiveCode.trim()}\nreturn condition;`
      : `${passiveCode.trim()}\nreturn true;`;
    out.push(`<passiveCondition>\n${body}\n</passiveCondition>`);
  }

  st.note = (out.join("\n") + "\n" + note.replace(/\n\s*\n\s*\n+/g, "\n").trim()).trim();
  st.messageType = 1;
}

// Typos in the MV data that made these scripts fail silently in MV.
const STATE_TYPO_FIXES = {
  148: [/^f \(this\.isPhysical\(\)/m, "if (this.isPhysical()"],   // Ponto Fraco
  215: [/target\.addState\(220\):/, "target.addState(220);"],     // Rolamento Defensivo
  // MV hack: the death state erased the unit's event itself. Gear erases fallen
  // units after the action and counts them (living heroes/enemies variables);
  // erasing first made Gear skip that count, so "all enemies down" never fired.
  1: [/<Custom Apply Effect>\s*user\.event\(\)\.erase\(\);\s*<\/Custom Apply Effect>/, ""],
};
{
  const statesData = mvData("States.json");
  for (const [id, [from, to]] of Object.entries(STATE_TYPO_FIXES)) {
    const s = statesData[id];
    if (s && from.test(s.note)) {
      s.note = s.note.replace(from, to);
      report.push(`state ${id} ${s.name}: script fixed (see STATE_TYPO_FIXES)`);
    }
  }
  statesData.forEach((s) => { if (s) convertState(s); });

  // Summon lifespans: MV knocked a summon out with "Desummoned" (66) + "HiddenHP" (67)
  // when its lifespan state ran out; now the summon leaves the battle.
  for (const s of statesData) {
    if (s && /user\.addState\(66\);\s*user\.addState\(67\);/.test(s.note)) {
      s.note = s.note.replace(/user\.addState\(66\);\s*user\.addState\(67\);/g, "user.honDesummon();");
    }
  }

  // Auras: MV listed them as script calls in common event 14 (AuraManager),
  // this.isActorAura(ownerEvent, auraState, range, childState, mode, xtra).
  // They become <aura> blocks on the aura state.
  const AURA_MODES = { 0: "keep", 1: "remove", 10: "counter", 11: "count" };
  const ce14 = mvData("CommonEvents.json")[14];
  for (const c of ce14.list) {
    if (c.code !== 355 && c.code !== 655) continue;
    const m = c.parameters[0].match(/is(Actor|Enemy|Unit)Aura\(\s*\$gameActors\.actor\((\d+)\)[^,]*,\s*(\d+)\s*,\s*([^,]+),\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+)\s*\)/);
    if (!m) continue;
    const [, side, ownerId, auraId, rangeExpr, childId, mode, xtra] = m;
    const range = rangeExpr.trim().replace(new RegExp(`\\$gameActors\\.actor\\(${ownerId}\\)\\.`, "g"), "a.");
    const lines = [`state: ${childId}`, `range: ${range}`,
      `target: ${side === "Actor" ? "ally" : side === "Enemy" ? "enemy" : "all"}`,
      `mode: ${AURA_MODES[mode] || "remove"}`];
    if (mode === "10") lines.push(`counter: a.param(${xtra})`);
    if (!AURA_MODES[mode]) report.push(`aura on state ${auraId}: MV mode ${mode} isn't ported (used "remove")`);
    statesData[auraId].note = `<aura>\n${lines.join("\n")}\n</aura>\n` + statesData[auraId].note;
    report.push(`aura: state ${auraId} ${statesData[auraId].name} -> state ${childId} (${lines.slice(1).join(", ")})`);
  }
  writeJson(mzDataPath("States.json"), statesData);
}

// -----------------------------------------------------------------------------
// 2. Skill conversion
// -----------------------------------------------------------------------------
const skills = mvData("Skills.json");
const states = mvData("States.json");

// States that only existed to fake the old action economy / submenus.
const ECONOMY_STATES = new Set([26, 101, 107, 121, 122, 352]);
// Passive "canUse..." mobility states (old workaround for moving after acting).
const MOBILITY_HACK_STATES = new Set([122, 123, 124, 125, 126]);

const block = (note, tag) => {
  const re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "i");
  const m = note.match(re);
  return m ? m[1] : null;
};
const removeBlock = (note, tag) =>
  note.replace(new RegExp("<" + tag + ">[\\s\\S]*?</" + tag + ">", "gi"), "");

// Show Eval bodies that only implemented the old action economy.
const isBoilerplateShow = (body) => {
  const cond = body.replace(/\s+/g, " ");
  const stripped = cond
    .replace(/(user|a)\.isStateAffected\((107|121|26|75)\)/g, "X")
    .replace(/(user|a)\.hideFullAction\(\)/g, "X")
    .replace(/(user|a)\.isStateCategoryAffected\('hideStandard'\)/g, "X")
    .replace(/!?\(?\$gameSwitches\.value\((2|6)\)\)?/g, "X");
  return !/[a-zA-Z_$]{2,}\.|\$game/.test(stripped.replace(/visible|true|false|else|if/g, ""));
};

// Submenu parents: a skill adds marker state N; its children call isSubAction(N).
const optionParents = {}; // markerState -> parentSkillId
const optionChildren = {}; // parentSkillId -> [childIds]
for (const s of skills) {
  if (!s) continue;
  const m = (block(s.note, "Before Eval") || "").match(/isSubAction\((\d+)\)/);
  if (m) {
    const marker = Number(m[1]);
    const parent = skills.find((p) => p && p.effects.some((e) => e.code === 21 && e.dataId === marker));
    if (parent) {
      optionParents[marker] = parent.id;
      (optionChildren[parent.id] = optionChildren[parent.id] || []).push(s.id);
    } else {
      report.push(`skill ${s.id} ${s.name}: isSubAction(${marker}) but no parent adds state ${marker}`);
    }
  }
}
const markerStates = new Set(Object.keys(optionParents).map(Number));

const RANGE_CODES = { "-2": "a.agi", "-3": "a.luk", "-4": "a.mat", "-5": "a.srpgMove()" };

function convertSkill(s) {
  let note = s.note;
  const tags = [];
  const leftovers = [];
  let action = null;
  let childOf = null;

  // --- Before Eval -> <action> + <script:before>
  const before = block(note, "Before Eval");
  if (before !== null) {
    let code = before;
    // misplaced tags that ended up inside the block (skills 246-249)
    code = code.replace(/<([A-Za-z]+:[^<>]*)>/g, (m, inner) => { tags.push("<" + inner + ">"); return ""; });
    code = code.replace(/<\/?Before Eval>/gi, ""); // duplicated opening tag (skill 68)
    if (/\ba\.isFullAction\(\);?/.test(code)) { action = "full"; code = code.replace(/\ba\.isFullAction\(\);?/g, ""); }
    if (/\ba\.isFreeAction\(\);?/.test(code)) { action = action || "free"; code = code.replace(/\ba\.isFreeAction\(\);?/g, ""); }
    const sub = code.match(/\ba\.isSubAction\((\d+)\);?/);
    if (sub) { childOf = optionParents[Number(sub[1])] || null; code = code.replace(/\ba\.isSubAction\(\d+\);?/g, ""); }
    note = removeBlock(note, "Before Eval");
    if (code.trim()) tags.push("<script:before>\n" + code.trim() + "\n</script>");
  }

  // --- After Eval -> <script:after>
  const after = block(note, "After Eval");
  if (after !== null) {
    note = removeBlock(note, "After Eval");
    if (after.trim()) tags.push("<script:after>\n" + after.trim() + "\n</script>");
  }

  // --- Custom Show Eval: drop boilerplate, keep the rest as <showScript>
  const show = block(note, "Custom Show Eval");
  if (show !== null) {
    note = removeBlock(note, "Custom Show Eval");
    if (!isBoilerplateShow(show)) {
      // the old economy checks inside a real condition become `false`
      const body = show
        .replace(/(user|a)\.isStateAffected\((107|121|26)\)/g, "false")
        .replace(/(user|a)\.hideFullAction\(\)/g, "false")
        .replace(/(user|a)\.isStateCategoryAffected\('hideStandard'\)/g, "false");
      tags.push("<showScript>\nvar visible = true;\n" + body.trim() + "\nreturn visible;\n</showScript>");
      leftovers.push("showScript");
    }
  }

  // --- Custom Requirement -> <require:notMoved> or <requireScript>
  const req = block(note, "Custom Requirement");
  if (req !== null) {
    note = removeBlock(note, "Custom Requirement");
    if (/^\s*if\s*\(\s*\$gameSystem\.battlerMoved\(\)\s*\)\s*\{\s*value\s*=\s*false;?\s*\}\s*else\s*\{\s*value\s*=\s*true;?\s*\}\s*$/.test(req)) {
      tags.push("<require:notMoved>");
    } else {
      tags.push("<requireScript>\nvar value = true;\n" + req.trim() + "\nreturn value;\n</requireScript>");
      leftovers.push("requireScript");
    }
  }

  // --- single-line tags
  note = note.replace(/<ImmediateSkill:\s*\d+>/gi, () => { action = action || "free"; return ""; });
  note = note.replace(/<addActionTimes:\s*-?\d+>/gi, "");
  note = note.replace(/<mapBattle:\s*\w+>/gi, ""); // every battle happens on the map now
  // <targetType:enemy|friend> (SRPG_ActionTypes) -> <target:enemy|ally> (HoN_Targeting)
  note = note.replace(/<targetType:\s*(\w+)\s*>/gi, (m, t) => `<target:${t.toLowerCase() === "friend" ? "ally" : "enemy"}>`);
  // "single" was a custom AoE shape in the MV SRPG_AoE.js meaning "only the target cell":
  // that's a plain single-target skill. Gear doesn't know the shape, and its AI
  // then decides the skill has no target at all.
  if (/<srpgAreaType:\s*single\s*>/i.test(note) || tags.some((t) => /<srpgAreaType:\s*single\s*>/i.test(t))) {
    note = note.replace(/<srpgAreaType:\s*single\s*>/gi, "").replace(/<srpgAreaRange:\s*\d+\s*>/gi, "");
    for (let i = tags.length - 1; i >= 0; i--) {
      if (/<srpgArea(Type|Range):/i.test(tags[i])) tags.splice(i, 1);
    }
    report.push(`skill ${s.id} ${s.name}: <srpgAreaType:single> -> plain single target`);
  }
  note = note.replace(/<Cooldown:\s*(\d+)>/gi, (m, n) => { tags.push(`<cooldown:${n}>`); return ""; });
  note = note.replace(/<Sort Priority:\s*(\d+)>/gi, (m, n) => { tags.push(`<order:${n}>`); return ""; });
  let passive = false;
  note = note.replace(/<Skill Type:\s*([\d,\s]+)>/gi, (m, list) => {
    const first = Number(list.split(",")[0]);
    if (first === 3) passive = true; else tags.push(`<menu:${first}>`);
    return "";
  });
  note = note.replace(/<srpgRange:\s*(-[2-5])>/gi, (m, code) => { tags.push(`<range:${RANGE_CODES[code]}>`); return ""; });
  note = note.replace(/<Passive State:\s*(\d+)>/gi, (m, id) => {
    id = Number(id);
    if (id === 209) { tags.push("<splitMove>"); return ""; }   // Fang: Ataque em Movimento
    if (MOBILITY_HACK_STATES.has(id)) return "";
    tags.push(`<passiveState:${id}>`);
    return "";
  });
  if (passive) tags.push("<passive>");

  // --- movement rules written in the descriptions
  const desc = s.description.replace(/\\C\[\d+\]/g, "");
  if (/só pode (ser )?(usad[oa]|usar|ativad[oa]).{0,25}antes de se mover/i.test(desc)) tags.push("<require:notMoved>");
  if (/não pode se mover (depois de usar|na mesma rodada)|evita se mover/i.test(desc)) tags.push("<lockMove>");

  // --- submenus
  if (optionChildren[s.id]) tags.push(`<options:${optionChildren[s.id].join(",")}>`);
  if (childOf) tags.push(`<optionOf:${childOf}>`);

  // --- action type (children inherit from their parent).
  // The "[Livre]" marker in the description is the source of truth.
  const livre = /\[Livre\]/i.test(desc);
  if (!passive && !childOf) {
    const decided = livre ? "free" : "full";
    if (action && action !== decided) report.push(`skill ${s.id} ${s.name}: old code said ${action}, description says ${decided} (used ${decided})`);
    tags.push(`<action:${decided}>`);
  }

  // --- effects: drop the economy / marker states
  s.effects = s.effects.filter((e) => !(e.code === 21 && (ECONOMY_STATES.has(e.dataId) || markerStates.has(e.dataId))));

  // --- leftovers report (Yanfly blocks we did not touch)
  for (const t of ["Custom Execution", "Custom MP Cost", "setup action", "target action", "whole action", "follow action", "finish action"]) {
    if (new RegExp("<" + t + ">", "i").test(note)) leftovers.push(t);
  }
  if (leftovers.length) report.push(`skill ${s.id} ${s.name}: kept ${[...new Set(leftovers)].join(", ")}`);

  // tidy up blank lines, prepend new tags (no duplicates)
  note = note.replace(/\n\s*\n\s*\n+/g, "\n").trim();
  s.note = ([...new Set(tags)].join("\n") + "\n" + note).trim();
}

// Typos in skill scripts.
const SKILL_TYPO_FIXES = {
  // Desafio Honrado: event_id doesn't exist, so the taunt pointed at nobody in MV
  153: [/a\.event\(\)\.event_id/, "a.event().eventId()"],
};
for (const [id, [from, to]] of Object.entries(SKILL_TYPO_FIXES)) {
  if (from.test(skills[id].note)) {
    skills[id].note = skills[id].note.replace(from, to);
    report.push(`skill ${id} ${skills[id].name}: fixed a typo that broke its script in MV`);
  }
}

for (const s of skills) {
  if (!s || !s.name) continue;
  s.messageType = 1;
  convertSkill(s);
}

// Summons: MV used one common event per summon (YEP EventSpawner + a pre-made
// actor per copy). Each becomes a <summon> block plus a <script:summoned>.
// The lifespan stays in the states MV already used (their remove script now
// calls honDesummon).
const SUMMONS = {
  66: { actor: 101, at: "user", count: "a.mat", animation: 149, script: "b.addState(64);" },  // Portão do Submundo
  177: { actor: 109, animation: 182, script: "b.addState(185);" },                          // Aliado da Natureza
  197: { actor: 110, animation: 185,                                                        // Muralha de Gelo
    script: "b.addState(196);\nb.setStateCounter(196, a.mat);\nb.addState(197);" },
  199: { actor: 110, animation: 185,                                                        // ... next block, cast by the last block
    script: "b.addState(196);\nb.setStateCounter(196, a.getStateCounter(196) - 1);\nif (b.getStateCounter(196) > 0) b.addState(197);\na.removeState(197);" },
  285: { actor: 120, animation: 194, script: "b.addState(232);" },                          // Servo da Noite
  315: { actor: 121, animation: 139, script: "b.addState(259);\nb.event().setDirection(8);" },// Armadilha de Corrente
  333: { actor: 123, count: "a.mat", animation: 205, script: "b.addState(277);" },          // Erguer os Mortos
  353: { actor: 133, animation: 208, script: "b.addState(293);" },                          // Cópia Ilusória
  397: { actor: 134, animation: 216,                                                        // Guardiões de Pedra
    script: "b.event().setDirection(a.event().direction());\nb.addState(328);\nb.addState(327);\nb.setStateCounter(327, a.mat);" },
  398: { actor: 134, animation: 216,                                                        // ... next guard, cast by the last guard
    script: "b.event().setDirection(a.event().direction());\nb.addState(327);\nb.setStateCounter(327, a.getStateCounter(327) - 1);\nif (b.getStateCounter(327) > 0) b.addState(328);\na.removeState(328);" },
};
// Invocar Abissal/Celestial/Sílfide/Sátiro set a counter on state 274 (1-4), and the
// common event picked states 270-273 from it, with the summoner's Magia as their counter.
for (const [id, n] of [[329, 1], [330, 2], [331, 3], [332, 4]]) {
  const st = 269 + n;
  SUMMONS[id] = { actor: 122, animation: 204, script: `b.addState(${st});\nb.setStateCounter(${st}, a.mat);` };
}
for (const [id, sm] of Object.entries(SUMMONS)) {
  const s = skills[id];
  const ce = s.effects.find((e) => e.code === 44);
  s.effects = s.effects.filter((e) => e.code !== 44);
  const lines = [`actor: ${sm.actor}`, `at: ${sm.at || "target"}`, `count: ${sm.count || "1"}`, `animation: ${sm.animation}`];
  s.note = `<summon>\n${lines.join("\n")}\n</summon>\n<script:summoned>\n${sm.script}\n</script>\n` + s.note;
  report.push(`skill ${id} ${s.name}: common event ${ce ? ce.dataId : "?"} -> <summon> actor ${sm.actor}`);
}
// "Outros" (items / end turn submenu) is replaced by menu commands.
skills[2].note = "<hidden>\n" + skills[2].note;

// The Move skill.
const move = JSON.parse(JSON.stringify(skills[2]));
Object.assign(move, {
  id: MOVE_SKILL_ID,
  name: "Mover",
  iconIndex: skills[36].iconIndex,
  description: "\\C[6][Livre]\\C[0] Move-se até \\C[3]Velocidade\\C[0] casas.",
  mpCost: 0, tpCost: 0, scope: 11, occasion: 1, animationId: 0,
  effects: [], message1: "", message2: "", messageType: 1,
  damage: { critical: false, elementId: 0, formula: "0", type: 0, variance: 0 },
  note: "<action:free>\n<move:walk>\n<perTurn:1>",
});
skills[MOVE_SKILL_ID] = move;
skills.forEach((s) => { if (s && s.messageType === undefined) s.messageType = 1; });
writeJson(mzDataPath("Skills.json"), skills);

// -----------------------------------------------------------------------------
// 3. System
// -----------------------------------------------------------------------------
const mzSys = readJson(mzDataPath("System.json"));
const mvSys = mvData("System.json");
const sys = Object.assign({}, mvSys);
for (const k of Object.keys(mzSys)) if (!(k in sys)) sys[k] = mzSys[k];
sys.terms = JSON.parse(JSON.stringify(mvSys.terms));
for (const k of Object.keys(mzSys.terms.messages)) {
  if (!(k in sys.terms.messages)) sys.terms.messages[k] = mzSys.terms.messages[k];
}
sys.terms.messages.touchUI = "UI de Toque";
sys.terms.messages.autosave = "Salvamento Automático";
sys.advanced = Object.assign({}, mzSys.advanced, { gameId: 48151623 });
sys.partyMembers = TEST_PARTY.slice();
sys.startMapId = TEST_MAP_ID;
sys.startX = 10;
sys.startY = 7;
sys.editMapId = TEST_MAP_ID;
sys.gameTitle = mvSys.gameTitle || "Heroes of Nowhere";
writeJson(mzDataPath("System.json"), sys);

// -----------------------------------------------------------------------------
// 4. Test map
// -----------------------------------------------------------------------------
for (const f of fs.readdirSync(path.join(MZ, "data"))) {
  if (/^Map\d+\.json$/.test(f)) fs.unlinkSync(mzDataPath(f));
}
const mvInfos = mvData("MapInfos.json");
const infos = [];
infos[TEST_MAP_ID] = Object.assign({}, mvInfos[TEST_MAP_ID], { parentId: 0, order: 2 });
infos[PVP_MAP_ID] = Object.assign({}, mvInfos[PVP_MAP_ID], { parentId: 0, order: 3 });

// Map 1: Gear's summon map (SRPG_Summon_MZ loads it at boot). Templates for
// summoned units go here as events; empty for now.
const SUMMON_MAP_ID = 1;
infos[SUMMON_MAP_ID] = { id: SUMMON_MAP_ID, expanded: false, name: "Invocações (modelos)", order: 1,
  parentId: 0, scrollX: 0, scrollY: 0 };
writeJson(mzDataPath("MapInfos.json"), infos);
{
  const w = 10, h = 10;
  const summonMap = Object.assign(mvData(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`), {
    displayName: "", width: w, height: h, data: new Array(w * h * 6).fill(0), events: [null, {
      id: 1, name: "Modelo", note: "", x: 0, y: 0,
      pages: [{ conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: "A",
        selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false,
        variableId: 1, variableValid: false, variableValue: 0 }, directionFix: false,
        image: { tileId: 0, characterName: "", direction: 2, pattern: 1, characterIndex: 0 },
        list: [{ code: 0, indent: 0, parameters: [] }], moveFrequency: 3,
        moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
        moveSpeed: 3, moveType: 0, priorityType: 1, stepAnime: false, through: false, trigger: 0, walkAnime: true }],
    }],
    note: "Modelos de invocação para SRPG_Summon_MZ.", autoplayBgm: false, autoplayBgs: false,
  });
  writeJson(mzDataPath("Map001.json"), summonMap);
}

const map = mvData(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`);
// Old battle logic events (spawning, YEP calls, old common events) are dropped.
for (const id of [15, 16, 17, 20, 21, 22, 23]) map.events[id] = null;
// Enemies that got an SRW version (e.g. Bárbaro -> Bandido).
for (const ev of map.events) {
  if (!ev) continue;
  const m = ev.note.match(/<type:enemy>\s*<id:(\d+)>/);
  const to = m && replaceEnemyOnMap[m[1]];
  if (!to) continue;
  ev.note = ev.note.replace(/<id:\d+>/, `<id:${to}>`);
  const u = SRW_ENEMIES.find((x) => replaceEnemyOnMap[x.from] === to);
  for (const p of ev.pages) Object.assign(p.image, { characterName: `$hon_${u.sprite}`, characterIndex: 0 });
}

const cmd = (code, indent, parameters) => ({ code, indent, parameters });
const plugin = (indent, command, text, args, lines) => [
  cmd(357, indent, ["SRPG_core_MZ", command, text, args]),
  ...lines.map((l) => cmd(657, indent, [l])),
];
const page = (list, opts = {}) => Object.assign({
  conditions: { actorId: 1, actorValid: false, itemId: 1, itemValid: false, selfSwitchCh: "A",
    selfSwitchValid: false, switch1Id: 1, switch1Valid: false, switch2Id: 1, switch2Valid: false,
    variableId: 1, variableValid: false, variableValue: 0 },
  directionFix: false,
  image: { tileId: 0, characterName: "", direction: 2, pattern: 1, characterIndex: 0 },
  list: list.concat([cmd(0, 0, [])]),
  moveFrequency: 3, moveRoute: { list: [{ code: 0, parameters: [] }], repeat: true, skippable: false, wait: false },
  moveSpeed: 3, moveType: 0, priorityType: 0, stepAnime: false, through: false, trigger: 0, walkAnime: true,
}, opts);
let nextId = map.events.length;
const addEvent = (name, note, x, y, pages) => {
  const id = nextId++;
  map.events[id] = { id, name, note, pages, x, y };
  return id;
};

// Autorun: pick a mode, then start the SRPG battle once. "PvP (Arena)" sets
// the match options (a stand-in for the old Inn lobby) and goes to the arena.
const startPage = page([
  cmd(123, 0, ["A", 0]),
  cmd(101, 0, ["", 0, 0, 2, ""]),
  cmd(401, 0, ["Escolha o modo de jogo."]),
  cmd(102, 0, [["Campanha", "PvP (Arena)"], -1, 0, 2, 0]),
  cmd(402, 0, [0, "Campanha"]),
  ...plugin(1, "StartEnd", "Start/End SRPG battle", { key: "start" }, ["Start/End toggle = start"]),
  cmd(0, 1, []),
  cmd(402, 0, [1, "PvP (Arena)"]),
  cmd(121, 1, [PVP_SWITCH, PVP_SWITCH, 0]),
  cmd(121, 1, [DEATHMATCH_SWITCH, DEATHMATCH_SWITCH, 0]),
  cmd(122, 1, [LIVES_VAR, LIVES_VAR, 0, 0, 1]), // 1 extra life each
  cmd(201, 1, [0, PVP_MAP_ID, 11, 10, 2, 0]),
  cmd(0, 1, []),
  cmd(404, 0, []),
], { trigger: 3 });
const donePage = page([]);
donePage.conditions.selfSwitchValid = true;
addEvent("Iniciar Batalha", "", 0, 0, [startPage, donePage]);

// Battle start: win/lose text.
addEvent("Início", "<type:battleStart>", 1, 0, [page([
  ...plugin(0, "winLoseCondition", "Set win/loss condition statement", { key: "clear", text: "" },
    ["Description of process = clear", "Text of win/loss conditions = "]),
  ...plugin(0, "winLoseCondition", "Set win/loss condition statement", { key: "win", text: "Derrote todos os inimigos." },
    ["Description of process = win", "Text of win/loss conditions = Derrote todos os inimigos."]),
  ...plugin(0, "winLoseCondition", "Set win/loss condition statement", { key: "lose", text: "Todos os heróis caem." },
    ["Description of process = lose", "Text of win/loss conditions = Todos os heróis caem."]),
])]);

// After each action: victory / defeat.
const endBattle = (indent, text) => [
  cmd(101, indent, ["", 0, 0, 2, ""]),
  cmd(401, indent, [text]),
  ...plugin(indent, "StartEnd", "Start/End SRPG battle", { key: "end" }, ["Start/End toggle = end"]),
  cmd(354, indent, []),
];
addEvent("Fim de Ação", "<type:afterAction>", 2, 0, [page([
  cmd(111, 0, [1, 2, 0, 0, 0]), // enemies alive == 0
  ...endBattle(1, "\\C[6]Vitória!\\C[0] Todos os inimigos foram derrotados."),
  cmd(0, 1, []),
  cmd(412, 0, []),
  cmd(111, 0, [1, 1, 0, 0, 0]), // actors alive == 0
  ...endBattle(1, "\\C[2]Derrota...\\C[0] Todos os heróis caíram."),
  cmd(0, 1, []),
  cmd(412, 0, []),
])]);

// The four test heroes, placed where CE "ComeçoDaBatalha" used to spawn them.
const actors = mvData("Actors.json");
[[10, 7], [10, 8], [11, 7], [11, 8], [10, 9]].forEach(([x, y], i) => {
  const a = actors[TEST_PARTY[i]];
  addEvent(a.name, `<type:actor><id:${a.id}>`, x, y, [page([], {
    image: SRW_ACTORS[a.id]
      ? { tileId: 0, characterName: `$hon_${SRW_ACTORS[a.id].sprite}`, direction: 2, pattern: 1, characterIndex: 0 }
      : { tileId: 0, characterName: a.characterName, direction: 2, pattern: 1, characterIndex: a.characterIndex },
  })]);
});
writeJson(mzDataPath(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`), map);

// PvP arena (MV Map014): the old draft/lobby events are dropped; two fixed
// teams for now. HoN_PvP runs the match (team turns, lives, winner switches).
{
  const arena = mvData(`Map${String(PVP_MAP_ID).padStart(3, "0")}.json`);
  arena.events = [null];
  let id = 1;
  const add = (name, note, x, y, pages) => { arena.events[id] = { id, name, note, pages, x, y }; id++; };
  add("Iniciar PvP", "", 0, 0, [page([
    cmd(123, 0, ["A", 0]),
    cmd(121, 0, [PVP_SWITCH, PVP_SWITCH, 0]),
    cmd(357, 0, ["SRPG_BattlePrepare_MZ", "Disable", "disable battle Prepare", {}]),
    ...plugin(0, "StartEnd", "Start/End SRPG battle", { key: "start" }, ["Start/End toggle = start"]),
  ], { trigger: 3 }), Object.assign(page([]), { conditions: Object.assign(page([]).conditions, { selfSwitchValid: true }) })]);
  add("Início", "<type:battleStart>", 1, 0, [page([
    ...plugin(0, "winLoseCondition", "Set win/loss condition statement", { key: "clear", text: "" },
      ["Description of process = clear", "Text of win/loss conditions = "]),
    ...plugin(0, "winLoseCondition", "Set win/loss condition statement", { key: "win", text: "Derrote a outra equipe." },
      ["Description of process = win", "Text of win/loss conditions = Derrote a outra equipe."]),
  ])]);
  const win = (sw, text) => [
    cmd(111, 0, [0, sw, 0]), // switch ON
    ...endBattle(1, text),
    cmd(0, 1, []),
    cmd(412, 0, []),
  ];
  add("Fim de Ação", "<type:afterAction>", 2, 0, [page([
    ...win(BLUE_WINS, "\\C[4]Equipe Azul\\C[0] venceu!"),
    ...win(RED_WINS, "\\C[2]Equipe Vermelha\\C[0] venceu!"),
  ])]);
  for (const [team, t] of Object.entries(PVP_TEAMS)) {
    t.actors.forEach((actorId, i) => {
      const a = actors[actorId];
      const [x, y] = t.cells[i];
      const look = SRW_ACTORS[a.id]
        ? { characterName: `$hon_${SRW_ACTORS[a.id].sprite}`, characterIndex: 0 }
        : { characterName: a.characterName, characterIndex: a.characterIndex };
      add(a.name, `<type:actor><id:${a.id}><team:${team}>`, x, y,
        [page([], { image: Object.assign({ tileId: 0, direction: t.dir, pattern: 1 }, look) })]);
    });
  }
  writeJson(mzDataPath(`Map${String(PVP_MAP_ID).padStart(3, "0")}.json`), arena);
}

// -----------------------------------------------------------------------------
// 5. Assets
// -----------------------------------------------------------------------------
function copyDir(src, dst, filter) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) n += copyDir(s, d, filter);
    else if (!filter || filter(f)) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}
// MZ-only formats that must not be replaced by the MV files of the same name.
const KEEP_MZ = new Set(["ButtonSet.png"]);
if (COPY_ASSETS) {
  const imgN = copyDir(path.join(MV, "img"), path.join(MZ, "img"), (f) => !KEEP_MZ.has(f));
  const audN = copyDir(path.join(MV, "audio"), path.join(MZ, "audio"), (f) => f.endsWith(".ogg"));
  console.log(`assets: ${imgN} images, ${audN} ogg files`);
}

// -----------------------------------------------------------------------------
// 6. Plugin parameters
// -----------------------------------------------------------------------------
const pjPath = path.join(MZ, "js", "plugins.js");
const pjSrc = fs.readFileSync(pjPath, "utf8");
const plugins = JSON.parse(pjSrc.slice(pjSrc.indexOf("["), pjSrc.lastIndexOf("]") + 1));
const core = plugins.find((p) => p.name === "SRPG_core_MZ").parameters;
Object.assign(core, {
  "Use Map Battle": "3", "Map Battle Switch": "99", "defaultMove": "4",
  "srpgBattleExpRate": "0", "srpgBattleExpRateForActors": "0", "srpgAutoBattleStateId": "0",
  "srpgBestSearchRouteSize": "60", "srpgPredictionWindowMode": "3",
  "useAgiAttackPlus": "false",         // agi is "Alcance" (range) in this game
  "srpgBattleReaction": "2",           // counters only from the counter-rate trait
  "srpgDefaultReactionSkill": "1",
  "srpgBattleEndAllHeal": "true", "srpgDamageDirectionChange": "true", "srpgSkipTargetForSelf": "true",
  "enemyDefaultClass": "Inimigo", "textSrpgEquip": "Arma", "textSrpgNone": "Nada", "textSrpgMove": "Velocidade",
  "textSrpgWeaponRange": "Alcance", "textSrpgWait": "Encerrar", "textSrpgWinLoseCondition": "Objetivos",
  "textSrpgWinCondition": "Condições de Vitória", "textSrpgLoseCondition": "Condições de Derrota",
  "textSrpgTurnEnd": "Encerrar Rodada", "textSrpgAutoBattle": "Automático", "textSrpgDamage": "Dano",
  "textSrpgHealing": "Cura", "textSrpgRange": "Alcance", "textSrpgOptMapBattle": "Pular cena de batalha",
});
// Gear sample settings that point at IDs which mean something else in this game.
core["battleDistanceID"] = "98";                 // var 6 is "SummonX" here
const pluginByName = (n) => plugins.find((p) => p.name === n);
pluginByName("SRPG_TerrainEffectPlus_MZ").status = false; // sample maps tags to states 60-64
// HoN_Actions owns the move step: these Gear shortcuts would skip its bookkeeping.
Object.assign(pluginByName("SRPG_UX_Cursor_MZ").parameters, {
  "Switch Actor While Moving": "false", "Quick Attack": "false",
});
Object.assign(pluginByName("SRPG_Summon_MZ").parameters, {
  "Summon Map Id": "1", "summon appear Animation Id": "0", "summon disappear Animation Id": "0",
});
const hon = [
  { name: "HoN_Core", status: true, description: "Heroes of Nowhere: tags, compiled scripts and helpers.", parameters: {} },
  { name: "HoN_States", status: true, description: "Heroes of Nowhere: state durations, passives, params, tags, counters, scripts.", parameters: {} },
  { name: "HoN_Actions", status: true, description: "Heroes of Nowhere: full/free actions and Move as a skill.",
    parameters: { "Move Skill ID": String(MOVE_SKILL_ID), "Default Action": "full", "Unit Switching": "free",
      "End Command": "Encerrar", "Item Command": "Itens" } },
  { name: "HoN_Targeting", status: true, description: "Heroes of Nowhere: sides, taunt, invisibility, marked targets.", parameters: {} },
  { name: "HoN_Summons", status: true, description: "Heroes of Nowhere: <summon> on skills.", parameters: {} },
  { name: "HoN_PvP", status: true, description: "Heroes of Nowhere: Blue vs Red on one screen, team turns, lives.",
    parameters: { "PvP Switch": String(PVP_SWITCH), "Blue State": "131", "Red State": "132",
      "Deathmatch Switch": String(DEATHMATCH_SWITCH), "Lives Variable": String(LIVES_VAR), "Lives State": "365",
      "Blue Wins Switch": String(BLUE_WINS), "Red Wins Switch": String(RED_WINS) } },
  { name: "HoN_FieldMotions", status: true, description: "Heroes of Nowhere: attack and cast animations on the map.",
    parameters: { "Attack Timing": "8,14,10", "Cast Timing": "18,20,10" } },
];
const kept = plugins.filter((p) => !p.name.startsWith("HoN_"));
const out = kept.concat(hon);
fs.writeFileSync(pjPath, "// Generated by RPG Maker.\n// Do not edit this file directly.\nvar $plugins =\n" +
  JSON.stringify(out, null, 0).replace(/\},\{"name"/g, '},\n{"name"') + ";\n");

// -----------------------------------------------------------------------------
fs.writeFileSync(path.join(__dirname, "import_report.txt"), report.join("\n") + "\n");
console.log(`done: ${skills.filter(Boolean).length} skills converted, ${report.length} notes in dev/import_report.txt`);
console.log(`submenus: ${Object.entries(optionChildren).map(([p, c]) => p + "->" + c.join("/")).join("  ")}`);
