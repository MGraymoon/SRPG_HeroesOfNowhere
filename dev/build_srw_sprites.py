"""dev/build_srw_sprites.py - turns Super Retro World sheets into MZ character files.

    python dev/build_srw_sprites.py [--assets "C:/Users/User/Pictures/Assets"]

For every character in CHARACTERS it writes, at 3x scale (SRW is drawn at 16 px
per tile, MZ uses 48):
  img/characters/$hon_<name>.png          walk sheet, 3 frames x 4 directions of 48x60
  img/characters/hon/<name>_<motion>.png  action sheet, 3 frames x 4 directions of 96x96
                                          (wind-up, strike, recoil), no shield

The SRW licence doesn't allow redistributing these sprites, so the outputs are
git-ignored: rebuild them from your own asset folder with this script.
"""
import argparse
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCALE = 3

# name -> (folder with <name>_frame16x20.png, folder with the ARPG sheets)
CHARACTERS = {
    "flame_witch": ("srw_new_characters/remakes/out", "srw_new_characters/remakes/out/flame_witch"),      # Elise
    "scarf_brawler": ("srw_new_characters/remakes/out", "srw_new_characters/remakes/out/scarf_brawler"),  # Fang
    "azure_elf": ("srw_new_characters/remakes/out", "srw_new_characters/remakes/out/azure_elf"),          # Nith
    "crimson_blade": ("srw_new_characters/remakes/out", "srw_new_characters/remakes/out/crimson_blade"),  # Sieglinde
    "bandit": ("srw_new_characters/bandit/out", "srw_new_characters/bandit/out/bandit"),
}
MOTIONS = ["slash01", "spear01", "spear02", "staff01", "staff02", "staff03", "staff04",
           "staff05", "staff06", "sword01", "sword02", "sword03"]


def upscale(img):
    return img.resize((img.width * SCALE, img.height * SCALE), Image.NEAREST)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assets", default=os.environ.get("SRW_ASSETS", r"C:/Users/User/Pictures/Assets"))
    args = ap.parse_args()
    chars_dir = os.path.join(ROOT, "img", "characters")
    motion_dir = os.path.join(chars_dir, "hon")
    os.makedirs(motion_dir, exist_ok=True)
    for name, (walk_dir, arpg_dir) in CHARACTERS.items():
        walk = Image.open(os.path.join(args.assets, walk_dir, f"{name}_frame16x20.png")).convert("RGBA")
        assert walk.size == (48, 80), f"{name}: unexpected walk sheet size {walk.size}"
        upscale(walk).save(os.path.join(chars_dir, f"$hon_{name}.png"))
        made = 0
        for motion in MOTIONS:
            src = os.path.join(args.assets, arpg_dir, f"{name}_{motion}_0.png")
            if not os.path.exists(src):
                continue
            sheet = Image.open(src).convert("RGBA")
            assert sheet.size == (96, 128), f"{src}: unexpected size {sheet.size}"
            upscale(sheet).save(os.path.join(motion_dir, f"{name}_{motion}.png"))
            made += 1
        print(f"{name}: walk sheet + {made} action sheets")


if __name__ == "__main__":
    main()
