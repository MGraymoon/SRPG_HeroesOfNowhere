//=============================================================================
// HoN_Core.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - core: note tags, compiled scripts, helpers.
 * @author Heroes of Nowhere
 * @base SRPG_core_MZ
 * @orderAfter SRPG_RangeControl_MZ
 * @orderAfter SRPG_PositionEffects_MZ
 *
 * @help
 * ============================================================================
 * What this plugin does
 * ============================================================================
 * Reads the HoN note tags once when the database loads, compiles every script
 * block once (instead of eval-ing text on every use), and reports errors with
 * the name of the skill/state they came from.
 *
 * In playtest a red box lists every script that failed to compile or crashed,
 * so typos show up on the first launch instead of failing silently.
 *
 * ============================================================================
 * Script blocks (skills, items, states, equipment, actors, classes, enemies)
 * ============================================================================
 *   <script:before> ... </script>   runs before the effect, once per target
 *   <script:after>  ... </script>   runs after the effect, once per target
 *   <showScript>    ... </showScript>     return false to hide the skill
 *   <requireScript> ... </requireScript>  return false (or a reason text)
 *                                         to grey the skill out
 *
 * Names available in every script:
 *   a / user / subject   the battler using the skill (or owning the state)
 *   b / target           the target (when there is one)
 *   item / skill         the skill or item
 *   value                the damage value (where it applies)
 *   v / s                $gameVariables._data / $gameSwitches._data
 *   HoN                  helper functions (see below)
 *
 * ============================================================================
 * Range
 * ============================================================================
 *   <range:formula>   skill range from a formula, e.g. <range:a.agi>
 *                     (in this game agi = Alcance, luk = Area, mat = Magia)
 *
 * ============================================================================
 * Helpers
 * ============================================================================
 *   HoN.adjacentUnits(battler, 'opponent' | 'friend' | 'any')  -> [battlers]
 *   HoN.isOpponent(a, b)  /  HoN.isFriend(a, b)
 *   HoN.unitAt(x, y)      -> battler standing on a cell, or null
 */

var Imported = Imported || {};
Imported.HoN_Core = "0.1";

var HoN = HoN || {};

(() => {
    "use strict";

    //=========================================================================
    // Errors
    //=========================================================================
    HoN.errors = [];
    const reported = new Set();

    HoN.reportError = function(label, error, code) {
        const key = label + "|" + (error && error.message);
        if (reported.has(key)) return;
        reported.add(key);
        const message = `${label}: ${error && error.message ? error.message : error}`;
        HoN.errors.push(message);
        console.error("[HoN] " + message + (code ? "\n--- code ---\n" + code : ""));
        HoN.refreshErrorBox();
    };

    HoN.refreshErrorBox = function() {
        if (!HoN.errors.length || typeof document === "undefined") return;
        if (!($gameTemp && $gameTemp.isPlaytest && $gameTemp.isPlaytest())) return;
        let box = document.getElementById("HoN_ErrorBox");
        if (!box) {
            box = document.createElement("div");
            box.id = "HoN_ErrorBox";
            box.title = "Click to hide";
            Object.assign(box.style, {
                position: "fixed", left: "8px", top: "8px", maxWidth: "70%", maxHeight: "40%",
                overflow: "auto", zIndex: 1000, background: "rgba(140,0,0,0.92)", color: "#fff",
                font: "12px monospace", padding: "6px 8px", border: "1px solid #fff",
                whiteSpace: "pre-wrap", cursor: "pointer",
            });
            box.onclick = () => (box.style.display = "none");
            document.body.appendChild(box);
        }
        box.style.display = "block";
        box.textContent = "HoN script errors (" + HoN.errors.length + "):\n" + HoN.errors.join("\n");
    };

    //=========================================================================
    // Compiling scripts
    //=========================================================================
    const PRELUDE =
        "var user = a, subject = a, origin = a, target = b, skill = item;" +
        "var v = $gameVariables._data, s = $gameSwitches._data;\n";

    HoN.compile = function(code, label) {
        try {
            const fn = new Function("a", "b", "item", "value", "HoN", PRELUDE + code);
            fn.label = label;
            fn.code = code;
            return fn;
        } catch (e) {
            HoN.reportError(label + " (syntax)", e, code);
            return null;
        }
    };

    // Runs a compiled script; on error reports it once and returns `fallback`.
    HoN.run = function(fn, a, b, item, value, fallback) {
        if (!fn) return fallback;
        try {
            return fn.call(a, a, b, item, value, HoN);
        } catch (e) {
            HoN.reportError(fn.label, e, fn.code);
            return fallback;
        }
    };

    HoN.compileExpression = function(expr, label) {
        return HoN.compile("return (" + expr + ");", label);
    };

    //=========================================================================
    // Reading notes
    //=========================================================================
    const labelOf = (obj, kind) => `${kind} ${obj.id} ${obj.name}`;

    HoN.parseNotes = function(obj, kind) {
        const note = obj.note || "";
        const hon = { scripts: {}, require: [], options: [] };
        const label = labelOf(obj, kind);

        // <script:event> ... </script>
        for (const m of note.matchAll(/<script:\s*(\w+)\s*>([\s\S]*?)<\/script>/gi)) {
            hon.scripts[m[1].toLowerCase()] = HoN.compile(m[2], `${label} <script:${m[1]}>`);
        }
        const showBlock = note.match(/<showScript>([\s\S]*?)<\/showScript>/i);
        if (showBlock) hon.showScript = HoN.compile(showBlock[1], `${label} <showScript>`);
        const reqBlock = note.match(/<requireScript>([\s\S]*?)<\/requireScript>/i);
        if (reqBlock) hon.requireScript = HoN.compile(reqBlock[1], `${label} <requireScript>`);

        // single-line tags (outside script blocks)
        const flat = note
            .replace(/<script:\s*\w+\s*>[\s\S]*?<\/script>/gi, "")
            .replace(/<(showScript|requireScript)>[\s\S]*?<\/\1>/gi, "");
        for (const m of flat.matchAll(/<require:\s*([^>]+)>/gi)) {
            for (const token of m[1].split(",")) if (token.trim()) hon.require.push(token.trim());
        }
        const tag = (name) => {
            const m = flat.match(new RegExp("<" + name + "(?::\\s*([^>]*))?>", "i"));
            return m ? (m[1] === undefined ? true : m[1].trim()) : undefined;
        };
        hon.action = tag("action");
        hon.cooldown = tag("cooldown") !== undefined ? Number(tag("cooldown")) : 0;
        hon.perTurn = tag("perTurn") !== undefined ? Number(tag("perTurn")) : 0;
        hon.move = tag("move");
        hon.lockMove = !!tag("lockMove");
        hon.splitMove = !!tag("splitMove");
        hon.passive = !!tag("passive");
        hon.hidden = !!tag("hidden");
        hon.menu = tag("menu") !== undefined ? Number(tag("menu")) : 99;
        hon.order = tag("order") !== undefined ? Number(tag("order")) : 0;
        hon.optionOf = tag("optionOf") !== undefined ? Number(tag("optionOf")) : 0;
        const options = tag("options");
        if (typeof options === "string") hon.options = options.split(",").map(Number).filter(Boolean);
        const range = tag("range");
        if (typeof range === "string") hon.range = HoN.compileExpression(range, `${label} <range>`);
        const moveRange = tag("moveRange");
        if (typeof moveRange === "string") {
            hon.moveRange = HoN.compileExpression(moveRange === "move" ? "a.honBaseMove()" : moveRange,
                `${label} <moveRange>`);
        }
        obj.hon = hon;
    };

    const KINDS = [
        ["$dataSkills", "Skill"], ["$dataItems", "Item"], ["$dataStates", "State"],
        ["$dataWeapons", "Weapon"], ["$dataArmors", "Armor"], ["$dataActors", "Actor"],
        ["$dataClasses", "Class"], ["$dataEnemies", "Enemy"],
    ];

    const _DataManager_onLoad = DataManager.onLoad;
    DataManager.onLoad = function(object) {
        _DataManager_onLoad.call(this, object);
        for (const [name, kind] of KINDS) {
            if (object === window[name]) {
                for (const obj of object) if (obj) HoN.parseNotes(obj, kind);
            }
        }
    };

    // Show compile errors once the game is running.
    const _Scene_Boot_start = Scene_Boot.prototype.start;
    Scene_Boot.prototype.start = function() {
        _Scene_Boot_start.call(this);
        HoN.refreshErrorBox();
    };

    //=========================================================================
    // Units on the map
    //=========================================================================
    HoN.unitAt = function(x, y) {
        for (const event of $gameMap.eventsXy(x, y)) {
            if (event.isErased()) continue;
            const arr = $gameSystem.EventToUnit(event.eventId());
            if (arr && arr[1] && (arr[0] === "actor" || arr[0] === "enemy") && arr[1].isAlive()) return arr[1];
        }
        return null;
    };

    // Team of a battler. PvP will replace this with real teams.
    HoN.teamOf = function(battler) {
        return battler.isActor() ? "actor" : "enemy";
    };
    HoN.isFriend = (a, b) => HoN.teamOf(a) === HoN.teamOf(b);
    HoN.isOpponent = (a, b) => !HoN.isFriend(a, b);

    HoN.adjacentUnits = function(battler, relation = "opponent") {
        const event = battler.event && battler.event();
        if (!event) return [];
        const result = [];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const unit = HoN.unitAt(event.posX() + dx, event.posY() + dy);
            if (!unit) continue;
            if (relation === "any" ||
                (relation === "opponent" && HoN.isOpponent(battler, unit)) ||
                (relation === "friend" && HoN.isFriend(battler, unit))) {
                result.push(unit);
            }
        }
        return result;
    };

    //=========================================================================
    // Range from <range:formula>
    //=========================================================================
    for (const cls of [Game_Actor, Game_Enemy]) {
        const _srpgSkillRange = cls.prototype.srpgSkillRange;
        cls.prototype.srpgSkillRange = function(skill) {
            if (skill && skill.hon && skill.hon.range) {
                const value = Number(HoN.run(skill.hon.range, this, null, skill, 0, 1)) || 0;
                return Math.max(Math.floor(value), this.srpgSkillMinRange(skill));
            }
            return _srpgSkillRange.call(this, skill);
        };
    }

    //=========================================================================
    // <script:before> / <script:after>
    //=========================================================================
    const _Game_Action_apply = Game_Action.prototype.apply;
    Game_Action.prototype.apply = function(target) {
        const item = this.item();
        const scripts = item && item.hon ? item.hon.scripts : null;
        const user = this.subject();
        if (scripts && scripts.before) HoN.run(scripts.before, user, target, item, 0);
        _Game_Action_apply.call(this, target);
        if (scripts && scripts.after) HoN.run(scripts.after, user, target, item, 0);
    };
})();
