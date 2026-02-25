include("$(PORT_DIR)/boards/manifest.py")

# Freeze panel init sequence into firmware (no filesystem dependency at boot)
# BOARD_DIR is drivers/boards/GUITION_4848, so ../../.. is the repo root
module("panel_init_guition_4848.py", base_path="$(BOARD_DIR)/../../../firmware")
