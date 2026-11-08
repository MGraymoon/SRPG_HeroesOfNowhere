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
const TEST_PARTY = [32, 4, 1, 19]; // Fang, Nith, Elise, Sieglinde
const MOVE_SKILL_ID = 501;
const report = [];

// -----------------------------------------------------------------------------
// 1. Database
// -----------------------------------------------------------------------------
const DB_FILES = ["Actors", "Classes", "Items", "Weapons", "Armors", "Enemies",
  "States", "Animations", "Tilesets", "CommonEvents", "Troops"];
for (const f of DB_FILES) {
  const data = mvData(f + ".json");
  if (f === "States") data.forEach((s) => { if (s) s.messageType = 1; });
  writeJson(mzDataPath(f + ".json"), data);
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

for (const s of skills) {
  if (!s || !s.name) continue;
  s.messageType = 1;
  convertSkill(s);
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
  note: "<action:free>\n<move:walk>\n<perTurn:1>\n<mapBattle:true>",
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

// Map 1: Gear's summon map (SRPG_Summon_MZ loads it at boot). Templates for
// summoned units go here as events; empty for now.
const SUMMON_MAP_ID = 1;
infos[SUMMON_MAP_ID] = { id: SUMMON_MAP_ID, expanded: false, name: "Invocações (modelos)", order: 1,
  parentId: 0, scrollX: 0, scrollY: 0 };
writeJson(mzDataPath("MapInfos.json"), infos);
{
  const w = 10, h = 10;
  const summonMap = Object.assign(mvData(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`), {
    displayName: "", width: w, height: h, data: new Array(w * h * 6).fill(0), events: [null],
    note: "Modelos de invocação para SRPG_Summon_MZ.", autoplayBgm: false, autoplayBgs: false,
  });
  writeJson(mzDataPath("Map001.json"), summonMap);
}

const map = mvData(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`);
// Old battle logic events (spawning, YEP calls, old common events) are dropped.
for (const id of [15, 16, 17, 20, 21, 22, 23]) map.events[id] = null;

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

// Autorun: start the SRPG battle once.
const startPage = page([
  ...plugin(0, "StartEnd", "Start/End SRPG battle", { key: "start" }, ["Start/End toggle = start"]),
  cmd(123, 0, ["A", 0]),
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
[[10, 7], [10, 8], [11, 7], [11, 8]].forEach(([x, y], i) => {
  const a = actors[TEST_PARTY[i]];
  addEvent(a.name, `<type:actor><id:${a.id}>`, x, y, [page([], {
    image: { tileId: 0, characterName: a.characterName, direction: 2, pattern: 1, characterIndex: a.characterIndex },
  })]);
});
writeJson(mzDataPath(`Map${String(TEST_MAP_ID).padStart(3, "0")}.json`), map);

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
  "Use Map Battle": "2", "Map Battle Switch": "99", "defaultMove": "4",
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
Object.assign(pluginByName("SRPG_Summon_MZ").parameters, {
  "Summon Map Id": "1", "summon appear Animation Id": "0", "summon disappear Animation Id": "0",
});
const hon = [
  { name: "HoN_Core", status: true, description: "Heroes of Nowhere: tags, compiled scripts and helpers.", parameters: {} },
  { name: "HoN_Actions", status: true, description: "Heroes of Nowhere: full/free actions and Move as a skill.",
    parameters: { "Move Skill ID": String(MOVE_SKILL_ID), "Default Action": "full", "Unit Switching": "free",
      "End Command": "Encerrar", "Item Command": "Itens" } },
];
const kept = plugins.filter((p) => !p.name.startsWith("HoN_"));
const out = kept.concat(hon);
fs.writeFileSync(pjPath, "// Generated by RPG Maker.\n// Do not edit this file directly.\nvar $plugins =\n" +
  JSON.stringify(out, null, 0).replace(/\},\{"name"/g, '},\n{"name"') + ";\n");

// -----------------------------------------------------------------------------
fs.writeFileSync(path.join(__dirname, "import_report.txt"), report.join("\n") + "\n");
console.log(`done: ${skills.filter(Boolean).length} skills converted, ${report.length} notes in dev/import_report.txt`);
console.log(`submenus: ${Object.entries(optionChildren).map(([p, c]) => p + "->" + c.join("/")).join("  ")}`);
