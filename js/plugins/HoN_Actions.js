//=============================================================================
// HoN_Actions.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - full/free actions, Move as a skill, unit menu.
 * @author Heroes of Nowhere
 * @base HoN_Core
 * @orderAfter HoN_Core
 *
 * @param Move Skill ID
 * @type skill
 * @desc The basic Move skill every player unit gets.
 * @default 501
 *
 * @param Default Action
 * @type select
 * @option full
 * @option free
 * @desc Action type for skills and items without an <action> tag.
 * @default full
 *
 * @param Unit Switching
 * @type select
 * @option free
 * @option locked
 * @desc free: you can leave a unit with actions left and come back later.
 * locked: once a unit has moved or acted, finish it before choosing another.
 * @default free
 *
 * @param End Command
 * @desc Menu text for ending the unit's turn.
 * @default Encerrar
 *
 * @param Item Command
 * @desc Menu text for items. Leave empty to hide the command.
 * @default Itens
 *
 * @help
 * ============================================================================
 * Rules
 * ============================================================================
 * Every turn, each player unit has:
 *   - one full action
 *   - free actions as long as it can pay for them (MP, cooldown, per-turn
 *     limit, conditions)
 *   - its Move (a free skill). Move can't be split: you pick one destination
 *     and leftover tiles are lost, unless the unit has <splitMove>.
 *
 * Selecting a unit opens its menu first, so it can act before moving.
 * After an action the menu reopens while the unit can still do something.
 * Cancel on the menu undoes the last move (if nothing happened since), or
 * releases the unit (Unit Switching = free).
 *
 * Unavailable skills stay in the menu, greyed out, and the help window says why.
 *
 * Enemies (v0.1): Gear's AI as usual - move, then one action. Cooldowns and
 * requirements still apply to them.
 *
 * ============================================================================
 * Skill / item tags
 * ============================================================================
 *   <action:full>  <action:free>    action type (default: plugin parameter)
 *   <cooldown:N>                    turns before it can be used again
 *                                   (1 = once per turn)
 *   <perTurn:N>                     uses per turn
 *   <require:notMoved>              only before moving this turn
 *   <require:notActed>              only before any action this turn
 *   <require:adjacentEnemy>         an enemy must be next to the user
 *   <require:state N>               user must have state N
 *   <require:!state N>              user must not have state N
 *       (several: <require:notMoved, adjacentEnemy> or several tags)
 *   <lockMove>                      no more movement this turn after using it
 *   <move:walk>                     a movement skill (uses the move grid)
 *   <moveRange:formula>             distance for a movement skill
 *                                   (default: the unit's Velocidade;
 *                                    "move" = the unit's Velocidade)
 *   <options:20,21,22>              opens a submenu with these skills; the
 *                                   chosen one inherits this skill's action
 *                                   type, cooldown and limits
 *   <optionOf:19>                   (on the option) hide it from the main menu
 *   <menu:N> <order:N>              sort position in the unit menu
 *   <passive>  <hidden>             never listed in the unit menu
 *
 * ============================================================================
 * Traits (skills the unit knows, states, equipment, class, actor)
 * ============================================================================
 *   <splitMove>   leftover movement stays after moving, so Move can be used
 *                 again until it runs out (Fang's Ataque em Movimento)
 */

var Imported = Imported || {};
Imported.HoN_Actions = "0.1";

(() => {
    "use strict";
    const params = PluginManager.parameters("HoN_Actions");
    const MOVE_SKILL_ID = Number(params["Move Skill ID"] || 501);
    const DEFAULT_ACTION = params["Default Action"] || "full";
    const UNIT_SWITCHING = params["Unit Switching"] || "free";
    const END_TEXT = params["End Command"] || "Encerrar";
    const ITEM_TEXT = params["Item Command"] === undefined ? "Itens" : params["Item Command"];

    const T = {
        fullUsed: "Ação completa já usada neste turno.",
        moved: "Já se moveu neste turno.",
        moveLocked: "Não pode mais se mover neste turno.",
        noMove: "Sem movimento disponível.",
        perTurn: "Já usada neste turno.",
        cooldown: (n) => `Em recarga: ${n} ${n === 1 ? "rodada" : "rodadas"}.`,
        notMoved: "Só pode ser usada antes de se mover.",
        notActed: "Só pode ser usada antes de agir.",
        adjacentEnemy: "Requer um inimigo adjacente.",
        state: (name) => `Requer: ${name}.`,
        noState: (name) => `Bloqueada por: ${name}.`,
        condition: "Condição não atendida.",
        mp: "PM insuficiente.",
        cannot: "Não pode ser usada agora.",
    };

    HoN.Actions = {};
    const A = HoN.Actions;

    //=========================================================================
    // Who follows these rules
    //=========================================================================
    // Player-controlled actors in an SRPG battle. Enemies keep Gear's flow.
    A.isControlled = function(battler) {
        return !!(battler && $gameSystem.isSRPGMode() && battler.isActor() && !battler.isAutoBattle());
    };

    const activeUnit = () => {
        const event = $gameTemp.activeEvent();
        if (!event) return null;
        const arr = $gameSystem.EventToUnit(event.eventId());
        return arr ? arr[1] : null;
    };
    const activeArray = () => {
        const event = $gameTemp.activeEvent();
        return event ? $gameSystem.EventToUnit(event.eventId()) : null;
    };

    //=========================================================================
    // Per-turn state
    //=========================================================================
    Game_BattlerBase.prototype.honTurn = function() {
        if (!this._honTurn) this.honResetTurn();
        return this._honTurn;
    };

    Game_BattlerBase.prototype.honResetTurn = function() {
        this._honTurn = {
            fullUsed: false, moved: false, moveUsed: false, moveLeft: 0,
            moveLocked: false, acted: false, uses: {}, lastMove: null, touched: false,
        };
    };

    Game_BattlerBase.prototype.honCooldowns = function() {
        if (!this._honCd) this._honCd = {};
        return this._honCd;
    };

    Game_BattlerBase.prototype.honTickCooldowns = function() {
        const cd = this.honCooldowns();
        for (const key of Object.keys(cd)) {
            cd[key]--;
            if (cd[key] <= 0) delete cd[key];
        }
    };

    // Every source of traits: known skills, states, equipment, class, actor.
    Game_BattlerBase.prototype.honTraitObjects = function() {
        const list = this.states().slice();
        if (this.isActor()) {
            list.push(this.actor(), this.currentClass(), ...this.equips().filter(Boolean), ...this.skills());
        } else if (this.isEnemy()) {
            list.push(this.enemy());
        }
        return list;
    };

    Game_BattlerBase.prototype.honHasTrait = function(name) {
        return this.honTraitObjects().some((obj) => obj && obj.hon && obj.hon[name]);
    };

    // The unit's Velocidade before HoN's turn rules.
    Game_BattlerBase.prototype.honBaseMove = function() {
        return this._honBaseMoveFn ? this._honBaseMoveFn() : 0;
    };

    //=========================================================================
    // Turn start: reset, tick cooldowns, let Gear never end the turn by itself
    //=========================================================================
    const _SRPGActionTimesSet = Game_Battler.prototype.SRPGActionTimesSet;
    Game_Battler.prototype.SRPGActionTimesSet = function() {
        _SRPGActionTimesSet.call(this);
        if (!$gameSystem.isSRPGMode()) return;
        this.honResetTurn();
        this.honTickCooldowns();
        if (A.isControlled(this)) this._SRPGActionTimes = 99;
    };

    const _startSRPG = Game_System.prototype.startSRPG;
    Game_System.prototype.startSRPG = function() {
        $gameParty.members().forEach((m) => { m._honCd = {}; m.honResetTurn(); });
        $gameTemp._honLockedUnit = 0;
        _startSRPG.call(this);
    };

    //=========================================================================
    // Movement
    //=========================================================================
    for (const cls of [Game_Actor, Game_Enemy]) {
        const _srpgMove = cls.prototype.srpgMove;
        cls.prototype._honBaseMoveFn = function() { return _srpgMove.call(this); };
        cls.prototype.srpgMove = function() {
            const base = _srpgMove.call(this);
            if (!A.isControlled(this)) return base;
            if (this._honMoveOverride != null) return this._honMoveOverride;
            const t = this.honTurn();
            if (t.moveLocked) return 0;
            if (t.moveUsed) return this.honHasTrait("splitMove") ? Math.max(t.moveLeft, 0) : 0;
            return base;
        };
    }

    A.isBasicMove = (item) => item && item.id === MOVE_SKILL_ID && DataManager.isSkill(item);

    //=========================================================================
    // Costs: which skill pays (a submenu option pays through its parent)
    //=========================================================================
    A.costSource = function(item) {
        if (DataManager.isSkill(item) && item.hon && item.hon.optionOf) return $dataSkills[item.hon.optionOf] || item;
        return item;
    };
    A.costKey = (item) => (DataManager.isItem(item) ? "i" : "s") + A.costSource(item).id;
    A.actionOf = function(item) {
        const src = A.costSource(item);
        return (src.hon && src.hon.action) || DEFAULT_ACTION;
    };

    //=========================================================================
    // Why can't the unit use this? (null = it can)
    //=========================================================================
    A.blockReason = function(battler, item) {
        if (!item || !item.hon || !$gameSystem.isSRPGMode()) return null;
        const t = battler.honTurn();
        const src = A.costSource(item);
        const h = src.hon;

        if (A.isControlled(battler)) {
            if (A.isBasicMove(item)) {
                if (t.moveLocked) return T.moveLocked;
                if (t.moveUsed && !(battler.honHasTrait("splitMove") && t.moveLeft > 0)) return T.moved;
                if (battler.honBaseMove() <= 0) return T.noMove;
            } else if (item.hon.move && t.moveLocked) {
                return T.moveLocked;
            }
            if (!A.isBasicMove(item) && A.actionOf(item) === "full" && t.fullUsed) return T.fullUsed;
        }
        const key = A.costKey(item);
        if (h.perTurn && !A.isBasicMove(item) && (t.uses[key] || 0) >= h.perTurn) return T.perTurn;
        const cd = battler.honCooldowns()[key];
        if (cd > 0) return T.cooldown(cd);

        for (const token of [...(h.require || []), ...(src !== item ? item.hon.require || [] : [])]) {
            const reason = A.checkRequire(battler, token);
            if (reason) return reason;
        }
        for (const obj of src !== item ? [src, item] : [item]) {
            if (obj.hon.requireScript) {
                const r = HoN.run(obj.hon.requireScript, battler, null, obj, 0, false);
                if (typeof r === "string" && r) return r;
                if (!r) return T.condition;
            }
        }
        return null;
    };

    A.checkRequire = function(battler, token) {
        const t = battler.honTurn();
        const m = token.match(/^(!)?state\s*:?\s*(\d+)$/i);
        if (m) {
            const has = battler.isStateAffected(Number(m[2]));
            const name = ($dataStates[Number(m[2])] || {}).name || "estado " + m[2];
            if (m[1] && has) return T.noState(name);
            if (!m[1] && !has) return T.state(name);
            return null;
        }
        switch (token) {
            case "notMoved": return t.moved ? T.notMoved : null;
            case "notActed": return t.acted ? T.notActed : null;
            case "adjacentEnemy": return HoN.adjacentUnits(battler, "opponent").length ? null : T.adjacentEnemy;
        }
        HoN.reportError("Unknown <require> condition", new Error(token));
        return null;
    };

    // Plug the rules into MZ's own "can use" checks, so every window agrees.
    const _meetsSkillConditions = Game_BattlerBase.prototype.meetsSkillConditions;
    Game_BattlerBase.prototype.meetsSkillConditions = function(skill) {
        return _meetsSkillConditions.call(this, skill) && !A.blockReason(this, skill);
    };
    const _meetsItemConditions = Game_BattlerBase.prototype.meetsItemConditions;
    Game_BattlerBase.prototype.meetsItemConditions = function(item) {
        return _meetsItemConditions.call(this, item) && !A.blockReason(this, item);
    };

    // Full reason text for a disabled entry in the menu.
    A.reasonText = function(battler, item) {
        const reason = A.blockReason(battler, item);
        if (reason) return reason;
        if (DataManager.isSkill(item) && !battler.canPaySkillCost(item)) return T.mp;
        if (!battler.canUse(item)) return T.cannot;
        return null;
    };

    //=========================================================================
    // Paying for an action
    //=========================================================================
    A.pay = function(battler, item) {
        if (!item || !item.hon) return;
        const t = battler.honTurn();
        const src = A.costSource(item);
        const key = A.costKey(item);
        if (A.actionOf(item) === "full") t.fullUsed = true;
        t.uses[key] = (t.uses[key] || 0) + 1;
        if (src.hon.cooldown > 0) battler.honCooldowns()[key] = src.hon.cooldown;
        if (src.hon.lockMove || item.hon.lockMove) t.moveLocked = true;
        if (item.hon.move) t.moved = true;
        t.acted = true;
        t.touched = true;
        t.lastMove = null;
        if (A.isControlled(battler) && UNIT_SWITCHING === "locked") $gameTemp._honLockedUnit = battler.srpgEventId();
    };

    // Gear calls this for every action that starts a battle (player and AI).
    // The cost is only recorded here and charged once the action is over:
    // charging now would make MZ's own "can use?" re-check fail mid-action.
    const _srpgBattleStart = Scene_Map.prototype.srpgBattleStart;
    Scene_Map.prototype.srpgBattleStart = function(userArray, targetArray) {
        const user = userArray[1];
        const action = user && user.currentAction();
        const item = action && action.item();
        if (item) user._honPending = { skill: DataManager.isSkill(item), id: item.id };
        return _srpgBattleStart.call(this, userArray, targetArray);
    };

    A.payPending = function(battler) {
        const p = battler && battler._honPending;
        if (!p) return;
        battler._honPending = null;
        A.pay(battler, p.skill ? $dataSkills[p.id] : $dataItems[p.id]);
    };

    //=========================================================================
    // What the unit can still do
    //=========================================================================
    A.menuSkills = function(actor) {
        const list = actor.skills().filter((s) => {
            const h = s.hon || {};
            if (h.passive || h.hidden || h.optionOf) return false;
            if (s.occasion === 3 || s.occasion === 2) return false;
            if (h.showScript && !HoN.run(h.showScript, actor, null, s, 0, true)) return false;
            return true;
        });
        const move = $dataSkills[MOVE_SKILL_ID];
        if (move && !list.includes(move)) list.unshift(move);
        const rank = (s) => (A.isBasicMove(s) ? 0 : s.hon && s.hon.move ? 1 : 2);
        return list.sort((x, y) => rank(x) - rank(y) || x.hon.menu - y.hon.menu ||
            x.hon.order - y.hon.order || x.id - y.id);
    };

    A.canDoAnything = function(actor) {
        if (!actor.canInput() || actor.isDead()) return false;
        const usable = (item) => actor.canUse(item);
        if (A.menuSkills(actor).some(usable)) return true;
        return $gameParty.items().some((item) => item.occasion !== 3 && usable(item));
    };

    //=========================================================================
    // Undo the last move
    //=========================================================================
    A.snapshot = (battler) => ({
        turn: JSON.parse(JSON.stringify(battler.honTurn())),
        cd: JSON.parse(JSON.stringify(battler.honCooldowns())),
    });

    A.undoMove = function(battler) {
        const t = battler.honTurn();
        const last = t.lastMove;
        const event = battler.event();
        if (!last || !event) return false;
        event.locate(last.x, last.y);
        event.setDirection(last.d);
        battler._honTurn = last.snap.turn;
        battler._honCd = last.snap.cd;
        battler.setMovedStep(last.steps || 0);
        return true;
    };

    //=========================================================================
    // Scene_Map: selecting a unit opens its menu
    //=========================================================================
    A.openMenu = function(event) {
        const arr = $gameSystem.EventToUnit(event.eventId());
        $gameTemp.setActiveEvent(event);
        $gameTemp.reserveOriginalPos(event.posX(), event.posY(), arr[1].srpgMove());
        $gameSystem.srpgMakeMoveTable(event);
        $gameTemp.setResetMoveList(true);
        $gameParty.clearSrpgBattleActors();
        $gameParty.pushSrpgBattleActors(arr[1]);
        // Actions are cleared after every action; menu commands need a fresh one.
        if (!arr[1].action(0)) arr[1].srpgMakeNewActions();
        $gameSystem.setSrpgActorCommandStatusWindowNeedRefresh(arr);
        $gameSystem.setSrpgActorCommandWindowNeedRefresh(arr);
        $gameSystem.setSubBattlePhase("actor_command_window");
    };

    A.closeMenu = function() {
        $gameSystem.clearSrpgActorCommandWindowNeedRefresh();
        $gameSystem.clearSrpgActorCommandStatusWindowNeedRefresh();
        $gameParty.clearSrpgBattleActors();
        $gameTemp.clearActiveEvent();
        $gameTemp.clearMoveTable();
        $gameTemp.setResetMoveList(true);
        $gameSystem.setSubBattlePhase("normal");
    };

    const _startMapEvent = Game_Player.prototype.startMapEvent;
    Game_Player.prototype.startMapEvent = function(x, y, triggers, normal) {
        const selecting = $gameSystem.isSRPGMode() && !$gameMap.isEventRunning() &&
            $gameSystem.isBattlePhase() === "actor_phase" && $gameSystem.isSubBattlePhase() === "normal";
        if (selecting && UNIT_SWITCHING === "locked" && $gameTemp._honLockedUnit) {
            const target = $gameMap.eventsXy(x, y).find((e) => e.isType() === "actor" && !e.isErased());
            if (target && target.eventId() !== $gameTemp._honLockedUnit) {
                const locked = $gameSystem.EventToUnit($gameTemp._honLockedUnit);
                if (locked && locked[1].canInput()) { SoundManager.playBuzzer(); return; }
                $gameTemp._honLockedUnit = 0;
            }
        }
        _startMapEvent.call(this, x, y, triggers, normal);
        if (selecting && $gameSystem.isSubBattlePhase() === "actor_move") {
            const unit = activeUnit();
            if (A.isControlled(unit)) A.openMenu($gameTemp.activeEvent());
        }
    };

    //=========================================================================
    // Scene_Map: the unit menu (Gear's actor command window, rebuilt)
    //=========================================================================
    const _actorCommandWindowRect = Scene_Map.prototype.actorCommandWindowRect;
    Scene_Map.prototype.actorCommandWindowRect = function() {
        const rect = _actorCommandWindowRect.call(this);
        rect.width = MENU_WIDTH;
        return rect;
    };

    const _createAllWindows = Scene_Map.prototype.createAllWindows;
    Scene_Map.prototype.createAllWindows = function() {
        _createAllWindows.call(this);
        const cmd = this._mapSrpgActorCommandWindow;
        cmd.setHandler("honSkill", this.honCommandSkill.bind(this));
        cmd.setHandler("wait", this.honCommandEnd.bind(this));
        cmd.setHandler("cancel", this.honCommandCancel.bind(this));
        cmd.setHelpWindow(this._helpWindow);
        this._helpWindow.height = this._helpWindow.fittingHeight(HELP_LINES);
        this._helpWindow.createContents();
        const rect = new Rectangle(0, 0, MENU_WIDTH, this.calcWindowHeight(4, true));
        this._honOptionsWindow = new Window_HonOptions(rect);
        this._honOptionsWindow.setHandler("honOption", this.honOnOption.bind(this));
        this._honOptionsWindow.setHandler("cancel", this.honOnOptionCancel.bind(this));
        this._honOptionsWindow.setHelpWindow(this._helpWindow);
        this.addWindow(this._honOptionsWindow);
    };

    const _makeCommandList = Window_ActorCommand.prototype.makeCommandList;
    Window_ActorCommand.prototype.makeCommandList = function() {
        if (!A.isControlled(this._actor)) return _makeCommandList.call(this);
        for (const skill of A.menuSkills(this._actor)) {
            this.addCommand(skill.name, "honSkill", this._actor.canUse(skill), skill.id);
        }
        if (ITEM_TEXT) {
            const hasItems = $gameParty.items().some((i) => i.occasion !== 3);
            if (hasItems) this.addCommand(ITEM_TEXT, "item", true);
        }
        this.addCommand(END_TEXT, "wait", true);
    };

    const _drawItem = Window_ActorCommand.prototype.drawItem;
    Window_ActorCommand.prototype.drawItem = function(index) {
        if (this.commandSymbol(index) !== "honSkill") return _drawItem.call(this, index);
        A.drawSkillLine(this, this._actor, $dataSkills[this._list[index].ext], this.itemLineRect(index),
            this.isCommandEnabled(index));
    };

    A.drawSkillLine = function(win, actor, skill, rect, enabled) {
        win.resetTextColor();
        win.changePaintOpacity(enabled);
        const cd = actor.honCooldowns()[A.costKey(skill)];
        let right = "";
        if (cd > 0) right = `Rec. ${cd}`;
        else if (actor.skillMpCost(skill) > 0) right = `${actor.skillMpCost(skill)} ${TextManager.mpA}`;
        const rw = right ? win.textWidth(right) + 8 : 0;
        win.drawItemName(skill, rect.x, rect.y, rect.width - rw);
        if (right) {
            if (cd > 0) win.changeTextColor(ColorManager.textColor(2));
            else win.changeTextColor(ColorManager.mpCostColor());
            win.drawText(right, rect.x + rect.width - rw, rect.y, rw, "right");
        }
        win.resetTextColor();
        win.changePaintOpacity(true);
    };

    // Description (2 lines) plus, when disabled, the reason on a third line.
    A.helpText = function(actor, item, enabled) {
        if (!item) return "";
        let text = (item.description || "").split("\n").slice(0, 2).join("\n");
        if (!enabled) {
            const reason = A.reasonText(actor, item);
            if (reason) text += (text.includes("\n") ? "\n" : "\n\n") + "\\C[18]" + reason + "\\C[0]";
        }
        return text;
    };

    const HELP_LINES = 3;
    const MENU_WIDTH = 340;

    // Keep the menu below the (3-line) help window and on screen.
    const _updatePlacement = Window_ActorCommand.prototype.updatePlacement;
    Window_ActorCommand.prototype.updatePlacement = function() {
        _updatePlacement.call(this);
        const help = SceneManager._scene && SceneManager._scene._helpWindow;
        if (!help || !A.isControlled(this._actor)) return;
        const minY = help.y + help.height;
        this.y = Math.max(this.y, minY);
        this.y = Math.min(this.y, Graphics.boxHeight - this.height);
    };

    const _updateHelp = Window_ActorCommand.prototype.updateHelp;
    Window_ActorCommand.prototype.updateHelp = function() {
        if (!A.isControlled(this._actor)) return _updateHelp.call(this);
        if (this.currentSymbol() === "honSkill") {
            this._helpWindow.setText(A.helpText(this._actor, $dataSkills[this.currentExt()], this.isCurrentItemEnabled()));
        } else if (this.currentSymbol() === "wait") {
            this._helpWindow.setText("Encerra o turno desta unidade.");
        } else if (this.currentSymbol() === "item") {
            this._helpWindow.setText("Usa um item do grupo.");
        } else {
            this._helpWindow.clear();
        }
    };

    // Keep the help window visible while the menu (or a submenu) is in use.
    const _update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _update.call(this);
        if (!this._helpWindow || !this._mapSrpgActorCommandWindow || !this._honOptionsWindow) return;
        const cmd = this._mapSrpgActorCommandWindow, opt = this._honOptionsWindow;
        const menuActive = (cmd.active && cmd.isOpen() && A.isControlled(cmd._actor)) || (opt.active && opt.isOpen());
        if (menuActive) {
            if (!this._helpWindow.visible) {
                this._helpWindow.show();
                (opt.active ? opt : cmd).callUpdateHelp();
            }
            this._honHelpOwned = true;
        } else if (this._honHelpOwned && !(this._itemWindow && this._itemWindow.active) &&
            !(this._skillWindow && this._skillWindow.active)) {
            this._helpWindow.hide();
            this._honHelpOwned = false;
        }
    };

    //=========================================================================
    // Menu commands
    //=========================================================================
    Scene_Map.prototype.honCommandSkill = function() {
        const actor = activeUnit();
        const skill = $dataSkills[this._mapSrpgActorCommandWindow.currentExt()];
        if (skill.hon.options && skill.hon.options.length) {
            this._honOptionsWindow.setup(actor, skill, this._mapSrpgActorCommandWindow);
            return;
        }
        if (skill.hon.move === "walk") return this.honStartMove(actor, skill);
        this.honStartSkill(actor, skill);
    };

    Scene_Map.prototype.honStartSkill = function(actor, skill) {
        if (!actor.action(0)) actor.srpgMakeNewActions();
        actor.action(0).setSkill(skill.id);
        this._deadActorWindow.setBack("null");
        this.startActorTargetting();
    };

    Scene_Map.prototype.honOnOption = function() {
        const actor = activeUnit();
        const skill = $dataSkills[this._honOptionsWindow.currentExt()];
        this._honOptionsWindow.close();
        this._honOptionsWindow.deactivate();
        this.honStartSkill(actor, skill);
    };

    Scene_Map.prototype.honOnOptionCancel = function() {
        this._honOptionsWindow.close();
        this._honOptionsWindow.deactivate();
        this._mapSrpgActorCommandWindow.activate();
    };

    Scene_Map.prototype.honCommandEnd = function() {
        const actor = activeUnit();
        actor._honForceEnd = true;
        actor.onAllActionsEnd();
        this.srpgAfterAction();
    };

    Scene_Map.prototype.honCommandCancel = function() {
        const actor = activeUnit();
        const cmd = this._mapSrpgActorCommandWindow;
        if (!A.isControlled(actor)) return this.selectPreviousActorCommand();
        const t = actor.honTurn();
        if (t.lastMove && A.undoMove(actor)) {
            SoundManager.playCancel();
            this.honRefreshMenu(actor);
            return;
        }
        if (UNIT_SWITCHING === "locked" && t.touched) {
            SoundManager.playBuzzer();
            cmd.activate();
            return;
        }
        A.closeMenu();
    };

    // Rebuild the menu and the range preview after something changed.
    Scene_Map.prototype.honRefreshMenu = function(actor) {
        const event = actor.event();
        $gameTemp.reserveOriginalPos(event.posX(), event.posY(), actor.srpgMove());
        $gameSystem.srpgMakeMoveTable(event);
        $gameTemp.setResetMoveList(true);
        const cmd = this._mapSrpgActorCommandWindow;
        cmd.refresh();
        cmd.activate();
        cmd.callUpdateHelp();
    };

    //=========================================================================
    // Move as a skill
    //=========================================================================
    Scene_Map.prototype.honStartMove = function(actor, skill) {
        const event = $gameTemp.activeEvent();
        if (!A.isBasicMove(skill)) {
            const range = skill.hon.moveRange ? HoN.run(skill.hon.moveRange, actor, null, skill, 0, 0) : actor.honBaseMove();
            actor._honMoveOverride = Math.max(0, Math.floor(Number(range) || 0));
        }
        $gameTemp._honMoveSkill = skill.id;
        $gameTemp._honMoveFrom = { x: event.posX(), y: event.posY(), d: event.direction(), snap: A.snapshot(actor),
            steps: actor.movedStep() };
        $gameTemp.reserveOriginalPos(event.posX(), event.posY(), actor.srpgMove());
        $gameSystem.srpgMakeMoveTable(event);
        $gameTemp.setResetMoveList(true);
        $gameSystem.clearSrpgActorCommandWindowNeedRefresh();
        $gameSystem.setSubBattlePhase("actor_move");
    };

    A.finishMove = function(actor) {
        const skill = $dataSkills[$gameTemp._honMoveSkill];
        const from = $gameTemp._honMoveFrom;
        const steps = actor.movedStep() || 0;
        const t = actor.honTurn();
        if (A.isBasicMove(skill)) {
            const available = t.moveUsed ? t.moveLeft : actor.honBaseMove();
            t.moveLeft = actor.honHasTrait("splitMove") ? Math.max(available - steps, 0) : 0;
            t.moveUsed = true;
            t.moved = true;
            t.touched = true;
            if (UNIT_SWITCHING === "locked") $gameTemp._honLockedUnit = actor.srpgEventId();
        } else {
            A.pay(actor, skill);
        }
        t.lastMove = { x: from.x, y: from.y, d: from.d, snap: from.snap, steps: from.steps };
        actor.setMovedStep((from.steps || 0) + steps);
        actor._honMoveOverride = null;
        $gameTemp._honMoveSkill = 0;
    };

    // Gear confirms the destination inside triggerAction.
    const _triggerAction = Game_Player.prototype.triggerAction;
    Game_Player.prototype.triggerAction = function() {
        const moving = $gameSystem.isSRPGMode() && $gameSystem.isSubBattlePhase() === "actor_move" &&
            $gameTemp._honMoveSkill;
        const result = _triggerAction.call(this);
        if (moving && $gameSystem.isSubBattlePhase() === "actor_command_window") {
            A.finishMove(activeUnit());
        }
        return result;
    };

    // Cancel while choosing a destination: back to the menu, not to the map.
    const _srpgCancelActorMove = Scene_Map.prototype.srpgCancelActorMove;
    Scene_Map.prototype.srpgCancelActorMove = function() {
        const actor = activeUnit();
        if (!$gameTemp._honMoveSkill || !A.isControlled(actor)) return _srpgCancelActorMove.call(this);
        SoundManager.playCancel();
        actor._honMoveOverride = null;
        $gameTemp._honMoveSkill = 0;
        A.openMenu($gameTemp.activeEvent());
    };

    // Cancel while choosing a target: back to the menu at the current position.
    const _srpgCancelActorTarget = Scene_Map.prototype.srpgCancelActorTarget;
    Scene_Map.prototype.srpgCancelActorTarget = function() {
        const actor = activeUnit();
        if (!A.isControlled(actor)) return _srpgCancelActorTarget.call(this);
        SoundManager.playCancel();
        $gameTemp.clearArea && $gameTemp.clearArea();
        A.openMenu($gameTemp.activeEvent());
    };

    //=========================================================================
    // After an action: end the unit only when it has nothing left
    //=========================================================================
    const _srpgAfterAction = Scene_Map.prototype.srpgAfterAction;
    Scene_Map.prototype.srpgAfterAction = function() {
        const event = $gameTemp.activeEvent();
        const battler = activeUnit();
        A.payPending(battler);
        _srpgAfterAction.call(this);
        if (!A.isControlled(battler)) return;
        if (battler._honForceEnd || !A.canDoAnything(battler)) {
            battler.setSrpgTurnEnd(true);
            battler._honForceEnd = false;
            if ($gameTemp._honLockedUnit === battler.srpgEventId()) $gameTemp._honLockedUnit = 0;
            $gameTemp._honReopen = 0;
        } else {
            $gameTemp._honReopen = event.eventId();
        }
    };

    const _passTurnNextUnit = Scene_Map.prototype.passTurnNextUnit;
    Scene_Map.prototype.passTurnNextUnit = function() {
        const id = $gameTemp._honReopen;
        $gameTemp._honReopen = 0;
        if (id && $gameSystem.isBattlePhase() === "actor_phase") {
            const event = $gameMap.event(id);
            const arr = $gameSystem.EventToUnit(id);
            if (event && !event.isErased() && arr && arr[1].canInput() && !arr[1].srpgTurnEnd()) {
                $gameTemp.clearTargetEvent();
                $gamePlayer.locate(event.posX(), event.posY());
                A.openMenu(event);
                return;
            }
        }
        _passTurnNextUnit.call(this);
    };

    //=========================================================================
    // Submenu window (<options:...>)
    //=========================================================================
    class Window_HonOptions extends Window_Command {
        initialize(rect) {
            super.initialize(rect);
            this.openness = 0;
            this.deactivate();
        }
        setup(actor, parent, anchor) {
            this._actor = actor;
            this._parent = parent;
            this.clearCommandList();
            this.makeCommandList();
            this.height = this.fittingHeight(Math.min(this.maxItems(), 6));
            // beside the menu, or over it when there's no room on the right
            this.x = anchor.x + anchor.width + this.width <= Graphics.boxWidth ? anchor.x + anchor.width : anchor.x;
            this.y = Math.min(anchor.y + (this.x === anchor.x ? this.lineHeight() : 0), Graphics.boxHeight - this.height);
            this.createContents();
            this.refresh();
            this.select(0);
            this.open();
            this.activate();
        }
        makeCommandList() {
            if (!this._parent) return;
            for (const id of this._parent.hon.options) {
                const skill = $dataSkills[id];
                if (skill) this.addCommand(skill.name, "honOption", this._actor.canUse(skill), id);
            }
        }
        drawItem(index) {
            A.drawSkillLine(this, this._actor, $dataSkills[this._list[index].ext], this.itemLineRect(index),
                this.isCommandEnabled(index));
        }
        updateHelp() {
            const skill = $dataSkills[this.currentExt()];
            this._helpWindow.setText(A.helpText(this._actor, skill, this.isCurrentItemEnabled()));
        }
    }
    window.Window_HonOptions = Window_HonOptions;
})();
