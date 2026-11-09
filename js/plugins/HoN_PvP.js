//=============================================================================
// HoN_PvP.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - PvP: Blue vs Red on one screen, team turns, lives.
 * @author Heroes of Nowhere
 * @base HoN_Targeting
 * @orderAfter HoN_Summons
 *
 * @param PvP Switch
 * @type switch
 * @desc While ON, an SRPG battle is a PvP match.
 * @default 7
 *
 * @param Blue State
 * @type state
 * @default 131
 *
 * @param Red State
 * @type state
 * @default 132
 *
 * @param Deathmatch Switch
 * @type switch
 * @desc While ON, units have lives and come back at their spawn point.
 * @default 92
 *
 * @param Lives Variable
 * @type variable
 * @desc Lives each unit starts with in a deathmatch.
 * @default 95
 *
 * @param Lives State
 * @type state
 * @desc Its counter holds the lives left.
 * @default 365
 *
 * @param Blue Wins Switch
 * @type switch
 * @default 94
 *
 * @param Red Wins Switch
 * @type switch
 * @default 93
 *
 * @help
 * ============================================================================
 * How a PvP match runs
 * ============================================================================
 * Turn on the PvP switch before "Start SRPG battle". Every unit is a hero
 * (actor event); mark each with <team:blue> or <team:red> in the event note.
 *
 * Each round: the Blue team plays its whole turn, then the Red team, then
 * the round ends. Only the team whose turn it is can be selected.
 *   - States count down at the start of their applier's team turn (the same
 *     rule as against enemies).
 *   - Skills aimed at "enemies" can only pick the other team, skills aimed at
 *     "allies" only your own (see HoN_Targeting). Area skills only affect the
 *     side they're meant for.
 *   - Summons join their summoner's team.
 *
 * Deathmatch (Deathmatch switch ON): each unit starts with the number of lives
 * in the Lives variable. A fallen unit with lives left comes back at its
 * spawn point, at full HP, at the start of its team's next turn, and loses a
 * life.
 *
 * When a team has nobody left standing (and no lives left), the other team's
 * win switch turns ON. Show the result and end the battle from an
 * <type:afterAction> event that checks those switches.
 */

var Imported = Imported || {};
Imported.HoN_PvP = "0.1";

(() => {
    "use strict";
    const p = PluginManager.parameters("HoN_PvP");
    const num = (k, d) => Number(p[k] || d);
    const PVP_SWITCH = num("PvP Switch", 7);
    const TEAM_STATE = { blue: num("Blue State", 131), red: num("Red State", 132) };
    const DEATHMATCH_SWITCH = num("Deathmatch Switch", 92);
    const LIVES_VAR = num("Lives Variable", 95);
    const LIVES_STATE = num("Lives State", 365);
    const WIN_SWITCH = { blue: num("Blue Wins Switch", 94), red: num("Red Wins Switch", 93) };
    const TEAM_NAME = { blue: "\\C[4]Equipe Azul\\C[0]", red: "\\C[2]Equipe Vermelha\\C[0]" };
    const core = PluginManager.parameters("SRPG_core_MZ");
    const ACTOR_VAR = Number(core["existActorVarID"] || 1);
    const TURN_VAR = Number(core["turnVarID"] || 3);

    const P = (HoN.PvP = {});
    P.active = () => $gameSystem.isSRPGMode() && $gameSwitches.value(PVP_SWITCH);
    P.team = () => $gameSystem._honPvpTeam || "blue";
    P.deathmatch = () => $gameSwitches.value(DEATHMATCH_SWITCH);

    //=========================================================================
    // Teams
    //=========================================================================
    // The team lives on the battler (death clears states); the team state is
    // added too, for display and for old scripts that check it.
    const _teamOf = HoN.teamOf;
    HoN.teamOf = function(battler) {
        if (battler && battler._honPvpTeam && P.active()) return battler._honPvpTeam;
        return _teamOf.call(this, battler);
    };

    P.join = function(unit, team) {
        unit._honPvpTeam = team;
        unit.addState(TEAM_STATE[team]);
    };

    // States given before the teams were set (or by a side-less source) count
    // down on their applier's team turn.
    const _honOriginSide = Game_BattlerBase.prototype.honOriginSide;
    Game_BattlerBase.prototype.honOriginSide = function(stateId) {
        const side = _honOriginSide.call(this, stateId);
        if (P.active() && !TEAM_STATE[side]) return HoN.teamOf(this.honOrigin(stateId));
        return side;
    };

    P.units = (team) => HoN.allUnits().filter((u) => !team || HoN.teamOf(u) === team);

    // Also counts fallen units whose events were erased, for lives and respawn.
    P.allTeamUnits = function(team) {
        const list = [];
        for (const event of $gameMap.events()) {
            const arr = $gameSystem.EventToUnit(event.eventId());
            if (arr && arr[0] === "actor" && arr[1] && HoN.teamOf(arr[1]) === team) list.push([event, arr[1]]);
        }
        return list;
    };

    // Battle start: <team:...> on events, spawn points, lives. Done once the
    // units exist and before battle-start events and the first turn, which
    // Gear starts from inside startSRPG.
    const _startSRPG = Game_System.prototype.startSRPG;
    Game_System.prototype.startSRPG = function() {
        if ($gameSwitches.value(PVP_SWITCH)) {
            this._honPvpTeam = "blue";
            for (const n of Object.values(WIN_SWITCH)) $gameSwitches.setValue(n, false);
        }
        _startSRPG.call(this);
    };

    const _runBattleStartEvent = Game_System.prototype.runBattleStartEvent;
    Game_System.prototype.runBattleStartEvent = function() {
        if (P.active()) P.setupTeams();
        _runBattleStartEvent.call(this);
    };

    P.setupTeams = function() {
        for (const event of $gameMap.events()) {
            const team = (event.event().meta.team || "").trim().toLowerCase();
            const arr = $gameSystem.EventToUnit(event.eventId());
            if (!arr || !arr[1] || !TEAM_STATE[team]) continue;
            const unit = arr[1];
            P.join(unit, team);
            unit._honSpawn = [event.posX(), event.posY()];
            P.setLives(unit, P.deathmatch() ? $gameVariables.value(LIVES_VAR) : 0);
        }
    };

    // Leaving the battle: forget the team (the same actors play the campaign).
    const _endSRPG = Game_System.prototype.endSRPG;
    Game_System.prototype.endSRPG = function() {
        for (const actor of $gameActors._data) {
            if (!actor || !actor._honPvpTeam) continue;
            actor.removeState(TEAM_STATE[actor._honPvpTeam]);
            actor.removeState(LIVES_STATE);
            actor._honPvpTeam = null;
            actor._honSpawn = null;
            actor._honLives = 0;
        }
        _endSRPG.call(this);
    };

    // Summons join their summoner's team.
    if (HoN.Summons) {
        const _perform = HoN.Summons.perform;
        HoN.Summons.perform = function(summoner, item) {
            const made = _perform.call(this, summoner, item);
            const team = HoN.teamOf(summoner);
            if (TEAM_STATE[team]) for (const unit of made) P.join(unit, team);
            if (made.length && HoN.refreshAuras) HoN.refreshAuras();
            return made;
        };
    }

    //=========================================================================
    // Team turns
    //=========================================================================
    // Only the team whose turn it is can act.
    const _canInput = Game_BattlerBase.prototype.canInput;
    Game_BattlerBase.prototype.canInput = function() {
        if (P.active() && this.isActor() && TEAM_STATE[HoN.teamOf(this)] && HoN.teamOf(this) !== P.team()) return false;
        return _canInput.call(this);
    };

    P.beginTeam = function(team) {
        $gameSystem._honPvpTeam = team;
        HoN.tickStates(team);
        P.respawn(team);
        if (HoN.refreshAuras) HoN.refreshAuras();
        P.checkWinner();
        $gameMessage.setBackground(1); // a dim strip mid-screen, clear of the status window
        $gameMessage.setPositionType(1);
        $gameMessage.add(`\\>${TEAM_NAME[team]} — Turno ${$gameVariables.value(TURN_VAR)}\\|\\^`);
        const first = P.units(team).find((u) => u.isAlive() && u.canInput());
        if (first) $gamePlayer.locate(first.event().posX(), first.event().posY());
    };

    // Round start: Blue first.
    const _srpgStartActorTurn = Game_System.prototype.srpgStartActorTurn;
    Game_System.prototype.srpgStartActorTurn = function() {
        _srpgStartActorTurn.call(this);
        if (P.active()) P.beginTeam("blue");
    };

    // Gear ends the actor phase when nobody can act: after Blue, Red plays.
    const _srpgStartAutoActorTurn = Game_System.prototype.srpgStartAutoActorTurn;
    Game_System.prototype.srpgStartAutoActorTurn = function() {
        if (P.active() && P.team() === "blue") {
            for (const unit of P.units("red")) unit.setSrpgTurnEnd(false);
            P.beginTeam("red");
            this.setBattlePhase("actor_phase");
            this.setSubBattlePhase("normal");
            return;
        }
        _srpgStartAutoActorTurn.call(this);
    };

    //=========================================================================
    // Both teams are heroes: let skills reach either side, and let
    // HoN_Targeting decide which side each skill may pick.
    //=========================================================================
    const pickable = (item) => item && item.scope > 0 && item.scope !== 11;
    const _isForOpponent = Game_Action.prototype.isForOpponent;
    Game_Action.prototype.isForOpponent = function() {
        if (P.active() && pickable(this.item())) return true;
        return _isForOpponent.call(this);
    };
    const _isForFriend = Game_Action.prototype.isForFriend;
    Game_Action.prototype.isForFriend = function() {
        if (P.active() && pickable(this.item())) return true;
        return _isForFriend.call(this);
    };

    // Area skills: keep only the units on the side the skill is meant for.
    if (Game_Temp.prototype.selectArea) {
        const _selectArea = Game_Temp.prototype.selectArea;
        Game_Temp.prototype.selectArea = function(user, action) {
            const found = _selectArea.call(this, user, action);
            if (!found || !P.active() || !action || !action.item()) return found;
            const want = HoN.Targeting.wantedSide(action.item());
            this._areaTargets = this._areaTargets.filter((t) => {
                const arr = t.event && $gameSystem.EventToUnit(t.event.eventId());
                const unit = arr && arr[1];
                if (!unit) return false;
                if (want === "enemy") return HoN.isOpponent(user, unit);
                if (want === "ally") return HoN.isFriend(user, unit);
                return true;
            });
            return this._areaTargets.length > 0;
        };
    }

    //=========================================================================
    // Lives and respawn
    //=========================================================================
    // Lives live on the battler too; state 365 shows them (its counter).
    P.lives = (unit) => unit._honLives || 0;
    P.setLives = function(unit, n) {
        unit._honLives = Math.max(0, n);
        if (!P.deathmatch()) return;
        unit.addState(LIVES_STATE);
        unit.setStateCounter(LIVES_STATE, unit._honLives);
    };

    P.respawn = function(team) {
        if (!P.deathmatch()) return;
        for (const [event, unit] of P.allTeamUnits(team)) {
            if (!unit.isDead() || !event.isErased() || P.lives(unit) <= 0 || !unit._honSpawn) continue;
            const [sx, sy] = unit._honSpawn;
            const cell = HoN.Summons ? HoN.Summons.cellsAround(sx, sy, "actor")[0] : [sx, sy];
            if (!cell) continue;
            unit.removeState(unit.deathStateId());
            unit.recoverAll(); // also clears states: give back team and lives
            P.join(unit, team);
            P.setLives(unit, P.lives(unit) - 1);
            event.locate(cell[0], cell[1]);
            event.appear();
            $gameVariables.setValue(ACTOR_VAR, $gameVariables.value(ACTOR_VAR) + 1);
            unit.SRPGActionTimesSet();
            unit.setSrpgTurnEnd(false);
            $gameMap.setEventImages();
            $gameTemp.requestAnimation([event], 0);
        }
    };

    //=========================================================================
    // Winner
    //=========================================================================
    // Summons don't keep a team in the match.
    P.standing = (team) => P.allTeamUnits(team)
        .some(([event, unit]) => !unit._honSummoned &&
            ((unit.isAlive() && !event.isErased()) || (P.deathmatch() && P.lives(unit) > 0)));

    P.checkWinner = function() {
        if (!P.active()) return null;
        const blue = P.standing("blue"), red = P.standing("red");
        if (blue && red) return null;
        const winner = blue ? "blue" : "red";
        $gameSwitches.setValue(WIN_SWITCH[winner], true);
        return winner;
    };

    // Check after every action, before the map's afterAction events run.
    const _eventAfterAction = Scene_Map.prototype.eventAfterAction;
    Scene_Map.prototype.eventAfterAction = function() {
        P.checkWinner();
        _eventAfterAction.call(this);
    };
})();
