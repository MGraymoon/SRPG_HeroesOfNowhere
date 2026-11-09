//=============================================================================
// HoN_FieldMotions.js
//=============================================================================
/*:
 * @target MZ
 * @plugindesc [v0.1] Heroes of Nowhere - attack and cast animations on the map (Super Retro World sheets).
 * @author Heroes of Nowhere
 * @base SRPG_core_MZ
 * @orderAfter HoN_Actions
 *
 * @param Attack Timing
 * @desc Frames for wind-up, strike and recoil of an attack. The hit lands when the strike starts.
 * @default 8,14,10
 *
 * @param Cast Timing
 * @desc Frames for wind-up, release and recoil of a cast. The spell lands when the release starts.
 * @default 18,20,10
 *
 * @help
 * ============================================================================
 * What this plugin does
 * ============================================================================
 * In map battles, the unit acting plays an action animation on its own map
 * sprite (wind-up, strike, recoil) and the hit lands on the strike frame.
 * Works for heroes, enemies and counterattacks.
 *
 * Action sheets live in img/characters/hon/<sprite>_<motion>.png: 3 frames by
 * 4 directions (down, left, right, up), 96x96 each - the Super Retro World ARPG
 * layout at 3x. dev/build_srw_sprites.py makes them.
 *
 * ============================================================================
 * Tags
 * ============================================================================
 * Actor, class or enemy:
 *   <fieldSprite: flame_witch>   which action sheets this unit uses
 *   <attackMotion: sword02>      motion for physical skills (default slash01)
 *   <castMotion: staff02>        motion for everything else (default staff01)
 *
 * Skill or item:
 *   <motion: attack>    use the unit's attack motion
 *   <motion: cast>      use the unit's cast motion
 *   <motion: staff06>   use this exact sheet
 *   <motion: none>      no animation
 *   Without the tag: physical skills attack, other skills cast, items nothing.
 *
 *   <projectile: none>     a cast at another unit doesn't fly a projectile
 *   <projectile: staff03>  use another staff's colours for the projectile
 *   By default a cast at another unit flies an orb in the colours of the
 *   caster's staff (staff01 magenta, 02 fire, 03 water, 04 nature, 05 light,
 *   06 gold), and the hit waits for it to arrive.
 *
 * ============================================================================
 * Reactions
 * ============================================================================
 * A unit that takes damage is pushed back from the attacker and flashes white;
 * a miss or evasion makes it sidestep. A unit that falls flashes red and fades
 * out where it stood.
 */

var Imported = Imported || {};
Imported.HoN_FieldMotions = "0.1";

(() => {
    "use strict";
    const params = PluginManager.parameters("HoN_FieldMotions");
    const timing = (text, fallback) => {
        const parts = String(text || fallback).split(",").map((n) => Math.max(1, Number(n) || 1));
        return parts.length === 3 ? parts : fallback.split(",").map(Number);
    };
    const TIMING = {
        attack: timing(params["Attack Timing"], "8,14,10"),
        cast: timing(params["Cast Timing"], "18,20,10"),
    };
    // The walk frame (16x20) sits at y=1..21 of the 32x32 action frame, so the
    // action frame's anchor is 21/32 of its height to keep the feet in place.
    const ACTION_ANCHOR_Y = 21 / 32;

    HoN.Field = {};
    const F = HoN.Field;

    //=========================================================================
    // Which sheet a unit uses for an item
    //=========================================================================
    const metaOf = (battler, key) => {
        const objs = battler.isActor() ? [battler.actor(), battler.currentClass()] : [battler.enemy()];
        for (const obj of objs) {
            if (obj && obj.meta && obj.meta[key]) return String(obj.meta[key]).trim();
        }
        return null;
    };

    F.motionFor = function(battler, item) {
        if (!battler || !item) return null;
        const sprite = metaOf(battler, "fieldSprite");
        if (!sprite) return null;
        let motion = item.meta && item.meta.motion ? String(item.meta.motion).trim() : null;
        if (!motion) {
            if (DataManager.isItem(item)) return null;
            motion = item.hitType === Game_Action.HITTYPE_PHYSICAL ? "attack" : "cast";
        }
        if (motion === "none") return null;
        if (motion === "attack") motion = metaOf(battler, "attackMotion") || "slash01";
        else if (motion === "cast") motion = metaOf(battler, "castMotion") || "staff01";
        const kind = /^staff/.test(motion) ? "cast" : "attack";
        return { sheet: `hon/${sprite}_${motion}`, timing: TIMING[kind], kind, motion };
    };

    // Projectile colours follow the orb on the caster's staff (pack palette):
    // outline, body, light, core.
    const ORB_COLORS = {
        staff01: ["#8e478c", "#be3fba", "#d74aba", "#ffd0da"], // magenta
        staff02: ["#a93b3b", "#e6482e", "#f47e1b", "#f4b41b"], // fire
        staff03: ["#394778", "#3978a8", "#28ccdf", "#dff6f5"], // water / ice
        staff04: ["#3c5956", "#397b44", "#71aa34", "#b6d53c"], // nature
        staff05: ["#827094", "#aaa8ce", "#cdd8e9", "#ffffff"], // light
        staff06: ["#a93b3b", "#f47e1b", "#f4b41b", "#f4cca1"], // gold
    };

    // A cast at another unit flies a projectile, unless <projectile: none>.
    F.projectileFor = function(battler, item, motion, userEvent, targetEvent) {
        if (!motion || motion.kind !== "cast" || !targetEvent || targetEvent === userEvent) return null;
        const tag = item.meta && item.meta.projectile ? String(item.meta.projectile).trim() : "";
        if (tag === "none") return null;
        const colors = ORB_COLORS[tag] || ORB_COLORS[motion.motion] || ORB_COLORS.staff05;
        const tiles = Math.abs(userEvent.x - targetEvent.x) + Math.abs(userEvent.y - targetEvent.y);
        return { colors, from: userEvent.eventId(), to: targetEvent.eventId(), travel: Math.max(10, tiles * 5) };
    };

    // Load a unit's usual sheets ahead of time so the first swing doesn't blink.
    F.preload = function(battler) {
        const sprite = metaOf(battler, "fieldSprite");
        if (!sprite) return;
        ImageManager.loadCharacter(`hon/${sprite}_${metaOf(battler, "attackMotion") || "slash01"}`);
        ImageManager.loadCharacter(`hon/${sprite}_${metaOf(battler, "castMotion") || "staff01"}`);
    };

    const _startSRPG = Game_System.prototype.startSRPG;
    Game_System.prototype.startSRPG = function() {
        _startSRPG.call(this);
        for (const unit of HoN.allUnits()) F.preload(unit);
    };

    //=========================================================================
    // The motion on the map character
    //=========================================================================
    Game_CharacterBase.prototype.honStartMotion = function(motion) {
        const [w, s, r] = motion.timing;
        this._honMotion = { sheet: motion.sheet, t: 0, frame: 0, w, s, total: w + s + r };
    };

    Game_CharacterBase.prototype.honMotion = function() {
        return this._honMotion || null;
    };

    const _update = Game_CharacterBase.prototype.update;
    Game_CharacterBase.prototype.update = function() {
        _update.call(this);
        const m = this._honMotion;
        if (!m) return;
        m.t++;
        m.frame = m.t < m.w ? 0 : m.t < m.w + m.s ? 1 : 2;
        if (m.t >= m.total) this._honMotion = null;
    };

    //=========================================================================
    // The sprite: swap to the action sheet while a motion plays
    //=========================================================================
    const _updateBitmap = Sprite_Character.prototype.updateBitmap;
    Sprite_Character.prototype.updateBitmap = function() {
        const m = this._character && this._character.honMotion && this._character.honMotion();
        if (m) {
            if (this._honSheet !== m.sheet) {
                this._honSheet = m.sheet;
                this.bitmap = ImageManager.loadCharacter(m.sheet);
            }
            return;
        }
        if (this._honSheet) {
            // back to the walk sheet
            this._honSheet = null;
            this._characterName = null;
            this.anchor.y = 1;
        }
        _updateBitmap.call(this);
    };

    const _updateFrame = Sprite_Character.prototype.updateFrame;
    Sprite_Character.prototype.updateFrame = function() {
        const m = this._honSheet && this._character.honMotion();
        if (m && this.bitmap && this.bitmap.isReady()) {
            const fw = this.bitmap.width / 3;
            const fh = this.bitmap.height / 4;
            const row = Math.max(0, (this._character.direction() - 2) / 2);
            this.setFrame(m.frame * fw, row * fh, fw, fh);
            this.anchor.y = ACTION_ANCHOR_Y;
            return;
        }
        _updateFrame.call(this);
    };

    //=========================================================================
    // Map battle: play the motion, land the hit on the strike frame
    //=========================================================================
    const _srpgInvokeMapSkill = Scene_Map.prototype.srpgInvokeMapSkill;
    Scene_Map.prototype.srpgInvokeMapSkill = function(data) {
        const phase = data.phase;
        const result = _srpgInvokeMapSkill.call(this, data);
        if (phase === "start" && (data.phase === "animation" || data.phase === "reflect")) {
            const item = data.action.item();
            const motion = F.motionFor(data.user, item);
            const event = motion && $gameMap.event(data.user.srpgEventId());
            if (event) {
                event.honStartMotion(motion);
                this._honMotionHold = motion.timing[0];
                const target = data.target && $gameMap.event(data.target.srpgEventId());
                const shot = F.projectileFor(data.user, item, motion, event, target);
                if (shot) {
                    event._honMotion.projectile = shot;
                    this._honMotionHold += shot.travel;
                }
            }
        }
        if (phase === "effect") F.reactToResult(data.user, data.target);
        return result;
    };

    //=========================================================================
    // Hit reactions: knockback and flash on damage, a sidestep on a miss
    //=========================================================================
    const HIT_FRAMES = 14;
    const DODGE_FRAMES = 12;

    F.reactToResult = function(user, target) {
        if (!user || !target || user === target) return;
        const userEvent = $gameMap.event(user.srpgEventId());
        const targetEvent = $gameMap.event(target.srpgEventId());
        if (!userEvent || !targetEvent) return;
        const result = target.result();
        const dx = Math.sign(targetEvent.x - userEvent.x);
        const dy = Math.sign(targetEvent.y - userEvent.y);
        if (result.isHit() && result.hpDamage > 0) {
            targetEvent._honHit = { t: 0, total: HIT_FRAMES, dx, dy, kind: "hit" };
        } else if (result.used && (result.missed || result.evaded)) {
            // step sideways relative to the attack
            targetEvent._honHit = { t: 0, total: DODGE_FRAMES, dx: dy !== 0 ? 1 : 0, dy: dx !== 0 ? -1 : 0, kind: "dodge" };
        }
    };

    const _charUpdateHit = Game_CharacterBase.prototype.update;
    Game_CharacterBase.prototype.update = function() {
        _charUpdateHit.call(this);
        const h = this._honHit;
        if (h && ++h.t >= h.total) this._honHit = null;
    };

    // Offset in pixels for the sprite: a quick push away that eases back.
    F.hitOffset = function(h) {
        const p = h.t / h.total;
        const amount = h.kind === "hit" ? 9 * Math.sin(Math.PI * Math.min(1, p * 1.6)) * (1 - p)
            : 10 * Math.sin(Math.PI * p);
        return [Math.round(h.dx * amount), Math.round(h.dy * amount)];
    };

    const _updatePosition = Sprite_Character.prototype.updatePosition;
    Sprite_Character.prototype.updatePosition = function() {
        _updatePosition.call(this);
        const h = this._character && this._character._honHit;
        if (h) {
            const [ox, oy] = F.hitOffset(h);
            this.x += ox;
            this.y += oy;
        }
    };

    const _spriteCharUpdate = Sprite_Character.prototype.update;
    Sprite_Character.prototype.update = function() {
        _spriteCharUpdate.call(this);
        const h = this._character && this._character._honHit;
        if (h && h.kind === "hit" && h.t < 8) {
            this.setBlendColor([255, 255, 255, 200 * (1 - h.t / 8)]);
            this._honFlashing = true;
        } else if (this._honFlashing) {
            this.setBlendColor([0, 0, 0, 0]);
            this._honFlashing = false;
        }
    };

    //=========================================================================
    // Knockouts: the fallen unit's sprite flashes red and fades where it stood
    //=========================================================================
    const _erase = Game_Event.prototype.erase;
    Game_Event.prototype.erase = function() {
        const arr = $gameSystem.isSRPGMode() && !this._erased && $gameSystem.EventToUnit(this.eventId());
        if (arr && arr[1] && arr[1].isDead()) F.spawnGhost(this);
        _erase.call(this);
    };

    F.spawnGhost = function(event) {
        const spriteset = SceneManager._scene && SceneManager._scene._spriteset;
        const name = event.characterName();
        if (!spriteset || !spriteset._tilemap || !name) return;
        spriteset._tilemap.addChild(new Sprite_HonGhost(event));
    };

    // The frame the unit was showing, worked out from its graphic (the map
    // sprite's own frame isn't reliable at the moment the event is erased).
    F.characterFrame = function(look, bitmap) {
        const big = ImageManager.isBigCharacter(look.name);
        const pw = bitmap.width / (big ? 3 : 12);
        const ph = bitmap.height / (big ? 4 : 8);
        const bx = big ? 0 : (look.index % 4) * 3;
        const by = big ? 0 : Math.floor(look.index / 4) * 4;
        const px = look.pattern < 3 ? look.pattern : 1;
        const py = (look.direction - 2) / 2;
        return [(bx + px) * pw, (by + py) * ph, pw, ph];
    };

    class Sprite_HonGhost extends Sprite {
        initialize(event) {
            const look = { name: event.characterName(), index: event.characterIndex(),
                pattern: event.pattern(), direction: event.direction() };
            super.initialize(ImageManager.loadCharacter(look.name));
            this.bitmap.addLoadListener(() => this.setFrame(...F.characterFrame(look, this.bitmap)));
            this.anchor.x = 0.5;
            this.anchor.y = 1;
            this.z = 3;
            this._realX = event._realX;
            this._realY = event._realY;
            this._shiftY = event.shiftY();
            this._t = 0;
            this.updatePosition();
        }
        updatePosition() {
            const tw = $gameMap.tileWidth(), th = $gameMap.tileHeight();
            this.x = Math.floor($gameMap.adjustX(this._realX) * tw + tw / 2);
            this.y = Math.floor($gameMap.adjustY(this._realY) * th + th) - this._shiftY + Math.floor(this._t / 8);
        }
        update() {
            super.update();
            this._t++;
            this.updatePosition();
            if (this._t < 10) this.setBlendColor([255, 64, 48, 160]);
            else this.setBlendColor([255, 64, 48, Math.max(0, 160 - (this._t - 10) * 8)]);
            this.opacity = Math.max(0, 255 - Math.max(0, this._t - 12) * 8);
            if (this.opacity <= 0 && this.parent) this.parent.removeChild(this);
        }
    }
    window.Sprite_HonGhost = Sprite_HonGhost;

    //=========================================================================
    // Projectiles: a pixel orb in the staff's colours, with a fading trail
    //=========================================================================
    const PX = 3; // one Super Retro World pixel on screen
    const ORB = [".ooo.", "omlmo", "olclo", "omlmo", ".ooo."];
    const orbCache = {};
    F.orbBitmap = function(colors) {
        const key = colors.join();
        if (orbCache[key]) return orbCache[key];
        const bmp = new Bitmap(ORB[0].length * PX, ORB.length * PX);
        const pick = { o: colors[0], m: colors[1], l: colors[2], c: colors[3] };
        ORB.forEach((row, y) => [...row].forEach((ch, x) => {
            if (pick[ch]) bmp.fillRect(x * PX, y * PX, PX, PX, pick[ch]);
        }));
        return (orbCache[key] = bmp);
    };

    class Sprite_HonProjectile extends Sprite {
        initialize(shot) {
            super.initialize(F.orbBitmap(shot.colors));
            this.anchor.x = 0.5;
            this.anchor.y = 0.5;
            this.z = 9;
            this._shot = shot;
            this._t = 0;
            this.updatePosition();
        }
        point(eventId) {
            const e = $gameMap.event(eventId);
            return e ? [e.screenX(), e.screenY() - 30] : null;
        }
        updatePosition() {
            const a = this.point(this._shot.from), b = this.point(this._shot.to);
            if (!a || !b) return;
            const p = Math.min(1, this._t / this._shot.travel);
            this.x = Math.round(a[0] + (b[0] - a[0]) * p);
            this.y = Math.round(a[1] + (b[1] - a[1]) * p - Math.sin(Math.PI * p) * 10);
        }
        update() {
            super.update();
            this._t++;
            this.updatePosition();
            if (this._t % 2 === 0 && this.parent) this.parent.addChild(new Sprite_HonSpark(this));
            if (this._t >= this._shot.travel && this.parent) this.parent.removeChild(this);
        }
    }

    class Sprite_HonSpark extends Sprite {
        initialize(orb) {
            super.initialize(new Bitmap(PX * 2, PX * 2));
            this.bitmap.fillRect(0, 0, PX * 2, PX * 2, orb._shot.colors[1]);
            this.anchor.x = 0.5;
            this.anchor.y = 0.5;
            this.x = orb.x;
            this.y = orb.y;
            this.z = 8;
            this._t = 0;
        }
        update() {
            super.update();
            this.opacity = 220 - this._t * 22;
            if (++this._t > 10 && this.parent) this.parent.removeChild(this);
        }
    }

    // Launch when the caster's motion reaches its release frame.
    const _spritesetUpdate = Spriteset_Map.prototype.update;
    Spriteset_Map.prototype.update = function() {
        _spritesetUpdate.call(this);
        for (const event of $gameMap.events()) {
            const m = event._honMotion;
            if (m && m.projectile && !m.projectile.launched && m.t >= m.w) {
                m.projectile.launched = true;
                this._tilemap.addChild(new Sprite_HonProjectile(m.projectile));
            }
        }
    };

    const _waitingForSkill = Scene_Map.prototype.waitingForSkill;
    Scene_Map.prototype.waitingForSkill = function() {
        if (this._honMotionHold > 0) return true;
        return _waitingForSkill.call(this);
    };

    const _sceneUpdate = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        if (this._honMotionHold > 0) this._honMotionHold--;
        _sceneUpdate.call(this);
    };
})();
