# Inventory WebSocket handlers: get_inventory_*, inventory_*.
# Extracted from control_panel.python.server for clarity.

import os
from datetime import datetime

import pylib as keyme

from control_panel.python.putil import SocketErrors, WebsocketError, WebsocketSuccess


def _inventory_days_since(ts_str):
    """Parse timestamp '%Y%m%d %H:%M' and return days since that time. Return 0 if None or invalid."""
    if not ts_str:
        return 0
    try:
        dt = datetime.strptime(ts_str, "%Y%m%d %H:%M")
        delta = datetime.now() - dt
        return max(0, delta.days)
    except (ValueError, TypeError):
        return 0


def get_inventory_list():
    """Return magazine list (1-20) with full fields and enabled/disabled days. IPC to INVENTORY only."""
    keyme.log.info("WS: requesting get_inventory_list")
    try:
        from inventory.interface_ipc_only import InventoryInterface
        interface = InventoryInterface()
    except Exception as e:
        keyme.log.error(f"get_inventory_list: failed to get InventoryInterface: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Inventory not available"]).to_json()
    try:
        stock_list = interface.get_magazine_list(include_status_data=True)
    except keyme.ipc.exceptions.TimeoutException:
        return WebsocketError([SocketErrors.IPC_TIMED_OUT.value, "Inventory not responding"]).to_json()
    except Exception as e:
        keyme.log.error(f"get_inventory_list: IPC failed: {e}")
        return WebsocketError([SocketErrors.IPC_ERROR.value, str(e)]).to_json()

    try:
        inv_config = keyme.config.cascade_load("inventory.json", process="inventory")
        low_threshold = int(inv_config.get("low_inventory_count", 25))
    except Exception:
        low_threshold = 25

    magazines = []
    for mag_num in range(1, 21):
        key = str(mag_num)
        tup = stock_list.get(key, ("None", 0, None, None, None, None))
        if len(tup) == 6:
            name, count, disabled_reason, disabled_at, enabled_at, qr_code = tup
        else:
            name, count = tup[0], tup[1]
            disabled_reason = disabled_at = enabled_at = qr_code = None

        if name == "None" or not name:
            magazines.append({
                "magazine": mag_num,
                "count": 0,
                "milling": None,
                "style": None,
                "display_name": None,
                "cost": None,
                "in_stock": False,
                "manufacturer": None,
                "disabled_reason": disabled_reason,
                "disabled_at": disabled_at,
                "enabled_at": enabled_at,
                "qr_code": qr_code or None,
                "enabled_days": 0,
                "disabled_days": _inventory_days_since(disabled_at),
            })
            continue
        try:
            full = interface.get_magazine_stock(mag_num)
        except Exception:
            full = None
        if not full:
            magazines.append({
                "magazine": mag_num,
                "count": count,
                "milling": None,
                "style": name,
                "display_name": None,
                "cost": None,
                "in_stock": disabled_reason is None,
                "manufacturer": None,
                "disabled_reason": disabled_reason,
                "disabled_at": disabled_at,
                "enabled_at": enabled_at,
                "qr_code": qr_code,
                "enabled_days": _inventory_days_since(enabled_at) if disabled_reason is None else 0,
                "disabled_days": _inventory_days_since(disabled_at) if disabled_reason else 0,
            })
        else:
            in_stock = full.get("in_stock", disabled_reason is None)
            magazines.append({
                "magazine": mag_num,
                "count": full.get("count", count),
                "milling": full.get("milling"),
                "style": full.get("name") or full.get("style"),
                "display_name": full.get("display_name"),
                "cost": full.get("cost"),
                "in_stock": in_stock,
                "manufacturer": full.get("manufacturer"),
                "disabled_reason": full.get("disabled_reason") or disabled_reason,
                "disabled_at": full.get("disabled_at") or disabled_at,
                "enabled_at": full.get("enabled_at") or enabled_at,
                "qr_code": full.get("qr_code") or qr_code,
                "enabled_days": _inventory_days_since(full.get("enabled_at")) if in_stock else 0,
                "disabled_days": _inventory_days_since(full.get("disabled_at")) if not in_stock else 0,
            })

    return WebsocketSuccess({"magazines": magazines, "low_inventory_threshold": low_threshold}).to_json()


def get_inventory_disabled_reasons():
    """Return list of allowed disable reasons (no IPC)."""
    keyme.log.info("WS: requesting get_inventory_disabled_reasons")
    try:
        from inventory.disabled_reasons import get_disabled_reasons
        reasons = get_disabled_reasons()
        return WebsocketSuccess({"reasons": reasons}).to_json()
    except Exception as e:
        keyme.log.error(f"get_inventory_disabled_reasons: {e}")
        return WebsocketError([SocketErrors.OTHER.value, str(e)]).to_json()


def get_inventory_millings_styles():
    """Return millings list and styles_by_milling from inventory/key_style_data.json (no IPC)."""
    keyme.log.info("WS: requesting get_inventory_millings_styles")
    try:
        path = os.path.join(keyme.config.PATH, "inventory", "key_style_data.json")
        style_data = keyme.config.load(path, logging=False)
        if not style_data or not isinstance(style_data, dict):
            return WebsocketSuccess({"millings": [], "styles_by_milling": {}}).to_json()
        millings = sorted(style_data.keys())
        styles_by_milling = {}
        for milling in style_data:
            milling_data = style_data[milling]
            if not isinstance(milling_data, dict):
                continue
            styles_set = set()
            for key_class, class_data in milling_data.items():
                if isinstance(class_data, dict) and "styles" in class_data:
                    for s in class_data["styles"]:
                        styles_set.add(s)
            styles_by_milling[milling] = sorted(styles_set)
        return WebsocketSuccess({"millings": millings, "styles_by_milling": styles_by_milling}).to_json()
    except Exception as e:
        keyme.log.error(f"get_inventory_millings_styles: {e}")
        return WebsocketError([SocketErrors.OTHER.value, str(e)]).to_json()


def _inventory_interface():
    from inventory.interface_ipc_only import InventoryInterface
    return InventoryInterface()


def _inventory_parse_magazine(data):
    """Return (magazine_int, None) when valid, or (None, error_json) when invalid."""
    raw = data.get("magazine")
    if raw is None:
        keyme.log.warning("inventory: invalid magazine (missing)")
        return (None, WebsocketError([SocketErrors.INVALID_INPUT.value, "magazine must be 1-20"]).to_json())
    try:
        magazine = int(raw)
    except (TypeError, ValueError):
        keyme.log.warning(f"inventory: invalid magazine {raw}")
        return (None, WebsocketError([SocketErrors.INVALID_INPUT.value, "magazine must be 1-20"]).to_json())
    if not (1 <= magazine <= 20):
        keyme.log.warning(f"inventory: invalid magazine {magazine} (out of range)")
        return (None, WebsocketError([SocketErrors.INVALID_INPUT.value, "magazine must be 1-20"]).to_json())
    return (magazine, None)


def _inventory_run_update_pricing_if_needed(interface, data):
    """Run update_pricing on kiosk when not no_api_update. Return None on success or when skipped, else error json."""
    if not getattr(keyme.config, "IS_KIOSK", False) or data.get("no_api_update"):
        return None
    from util.update_pricing import update_pricing
    if update_pricing() != 0:
        interface.restore_backup(do_full_update=False)
        keyme.log.error("Inventory: update_pricing failed after edit; restored backup")
        return WebsocketError([SocketErrors.OTHER.value, "Update pricing failed"]).to_json()
    return None


def inventory_enable_magazine(data):
    """Enable a magazine. Mirror script -e path; backup, enable, update_pricing on kiosk."""
    keyme.log.info("WS: requesting inventory_enable_magazine")
    magazine, err = _inventory_parse_magazine(data)
    if err:
        return err
    try:
        interface = _inventory_interface()
        interface.export_stock(backup=True)
        success = interface.enable_magazine(magazine)
        if not success:
            keyme.log.error(f"inventory_enable_magazine: enable failed for magazine {magazine}")
            return WebsocketError([SocketErrors.OTHER.value, "Enable failed"]).to_json()
        err = _inventory_run_update_pricing_if_needed(interface, data)
        return err if err is not None else WebsocketSuccess({}).to_json()
    except keyme.ipc.exceptions.TimeoutException:
        keyme.log.error("inventory_enable_magazine: Inventory not responding (timeout)")
        return WebsocketError([SocketErrors.IPC_TIMED_OUT.value, "Inventory not responding"]).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_enable_magazine: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()


def inventory_disable_magazine(data):
    """Disable a magazine with reason. Mirror script -d path."""
    keyme.log.info("WS: requesting inventory_disable_magazine")
    magazine, err = _inventory_parse_magazine(data)
    if err:
        return err
    reason = data.get("reason")
    if not reason:
        keyme.log.warning("inventory_disable_magazine: validation failed: reason required")
        return WebsocketError([SocketErrors.INVALID_INPUT.value, "reason required"]).to_json()
    try:
        from inventory import disabled_reasons
        if reason not in disabled_reasons.POSSIBLE_REASONS:
            keyme.log.warning(f"inventory_disable_magazine: invalid reason {reason}")
            return WebsocketError([
                SocketErrors.INVALID_INPUT.value,
                f"Invalid reason. Possible: {disabled_reasons.POSSIBLE_REASONS}",
            ]).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_disable_magazine: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()
    try:
        interface = _inventory_interface()
        interface.export_stock(backup=True)
        success = interface.disable_magazine(magazine, reason, needs_review=False)
        if not success:
            keyme.log.error(f"inventory_disable_magazine: disable failed for magazine {magazine}")
            return WebsocketError([SocketErrors.OTHER.value, "Disable failed"]).to_json()
        err = _inventory_run_update_pricing_if_needed(interface, data)
        return err if err is not None else WebsocketSuccess({}).to_json()
    except keyme.ipc.exceptions.TimeoutException:
        keyme.log.error("inventory_disable_magazine: Inventory not responding (timeout)")
        return WebsocketError([SocketErrors.IPC_TIMED_OUT.value, "Inventory not responding"]).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_disable_magazine: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()


def inventory_set_key_count(data):
    """Set key count for a magazine. Mirror script -cc path; sanity check capacity."""
    keyme.log.info("WS: requesting inventory_set_key_count")
    magazine, err = _inventory_parse_magazine(data)
    if err:
        return err
    new_count = data.get("new_count")
    if new_count is None:
        keyme.log.warning("inventory_set_key_count: validation failed: new_count required")
        return WebsocketError([SocketErrors.INVALID_INPUT.value, "new_count required"]).to_json()
    try:
        new_count = int(new_count)
        if new_count < 0:
            raise ValueError("new_count must be non-negative")
    except (TypeError, ValueError) as e:
        keyme.log.warning(f"inventory_set_key_count: validation failed: {e}")
        return WebsocketError([SocketErrors.INVALID_INPUT.value, str(e)]).to_json()
    try:
        interface = _inventory_interface()
        mag_stock = interface.get_magazine_stock(magazine)
        if not mag_stock:
            keyme.log.error(f"inventory_set_key_count: magazine {magazine} has no key data")
            return WebsocketError([SocketErrors.OTHER.value, "Magazine has no key data"]).to_json()
        milling = mag_stock.get("milling")
        style = mag_stock.get("name") or mag_stock.get("style")
        if not milling or not style:
            keyme.log.error(f"inventory_set_key_count: magazine {magazine} missing milling or style")
            return WebsocketError([SocketErrors.OTHER.value, "Missing milling or style for magazine"]).to_json()
        capacity = interface.get_magazine_capacity(milling, style)
        if capacity is None:
            keyme.log.error(f"inventory_set_key_count: missing capacity for {milling}-{style}")
            return WebsocketError([SocketErrors.OTHER.value, f"Missing magazine capacity for {milling}-{style}"]).to_json()
        if not data.get("force") and new_count > capacity:
            keyme.log.warning(f"inventory_set_key_count: count {new_count} exceeds capacity {capacity}")
            return WebsocketError([
                SocketErrors.INVALID_INPUT.value,
                f"Count {new_count} exceeds max capacity {capacity} for {milling}-{style}",
            ]).to_json()
        interface.export_stock(backup=True)
        success = interface.set_key_count(magazine, new_count)
        if not success:
            keyme.log.error(f"inventory_set_key_count: set_key_count failed for magazine {magazine}")
            return WebsocketError([SocketErrors.OTHER.value, "Set count failed"]).to_json()
        err = _inventory_run_update_pricing_if_needed(interface, data)
        return err if err is not None else WebsocketSuccess({}).to_json()
    except keyme.ipc.exceptions.TimeoutException:
        keyme.log.error("inventory_set_key_count: Inventory not responding (timeout)")
        return WebsocketError([SocketErrors.IPC_TIMED_OUT.value, "Inventory not responding"]).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_set_key_count: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()


_ADVANCED_ACTIONS = frozenset((
    'add_magazine', 'replace_keys', 'replace_magazine',
    'remove_magazine', 'fix_magazine', 'mark_reviewed',
))


def inventory_advanced_action(data):
    """Add / Replace / Remove / Fix / Mark reviewed. Mirrors update_inventory.py via IPC."""
    keyme.log.info("WS: requesting inventory_advanced_action")
    magazine, err = _inventory_parse_magazine(data)
    if err:
        return err
    action = data.get("action")
    if action not in _ADVANCED_ACTIONS:
        keyme.log.warning(f"inventory_advanced_action: invalid action {action}")
        return WebsocketError([SocketErrors.INVALID_INPUT.value, "invalid action"]).to_json()

    try:
        interface = _inventory_interface()
        mag_stock = interface.get_magazine_stock(magazine)

        if action == 'mark_reviewed':
            success = interface.mark_as_reviewed(magazine)
            if not success:
                keyme.log.error(f"inventory_advanced_action: mark_reviewed failed for magazine {magazine}")
                return WebsocketError([SocketErrors.OTHER.value, "Mark reviewed failed"]).to_json()
            return WebsocketSuccess({}).to_json()

        if action == 'remove_magazine':
            if not mag_stock:
                keyme.log.warning(f"inventory_advanced_action: remove_magazine on empty slot {magazine}")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "Slot is empty; nothing to remove."]).to_json()
            interface.export_stock(backup=True)
            success = interface.change_magazine(magazine, None)
            if not success:
                keyme.log.error(f"inventory_advanced_action: remove failed for magazine {magazine}")
                return WebsocketError([SocketErrors.OTHER.value, "Remove failed"]).to_json()
            err = _inventory_run_update_pricing_if_needed(interface, data)
            return err if err is not None else WebsocketSuccess({}).to_json()

        if action == 'fix_magazine':
            fix_field = (data.get("fix_field") or "").strip().lower()
            fix_value = (data.get("fix_value") or "").strip()
            if fix_field not in ('milling', 'style'):
                keyme.log.warning(f"inventory_advanced_action: fix_field must be milling or style, got {fix_field}")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "fix_field must be milling or style"]).to_json()
            if not fix_value:
                keyme.log.warning("inventory_advanced_action: fix_value is required")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "fix_value is required"]).to_json()
            if not mag_stock:
                keyme.log.warning(f"inventory_advanced_action: fix_magazine on empty slot {magazine}")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "Slot is empty; nothing to fix."]).to_json()
            attribute = "milling" if fix_field == "milling" else "name"
            key_data = {"magazine": magazine, attribute: fix_value}
            from inventory.magazine_actions import MagazineAction
            interface.export_stock(backup=True)
            success = interface.update_magazine_data(magazine, key_data, reason=MagazineAction.FIX_DATA)
            if not success:
                keyme.log.error(f"inventory_advanced_action: fix failed for magazine {magazine}")
                return WebsocketError([SocketErrors.OTHER.value, "Fix failed"]).to_json()
            err = _inventory_run_update_pricing_if_needed(interface, data)
            return err if err is not None else WebsocketSuccess({}).to_json()

        # add_magazine, replace_keys, replace_magazine
        milling = (data.get("milling") or "").strip()
        style = (data.get("style") or "").strip()
        count = data.get("count")
        if not milling or not style:
            keyme.log.warning("inventory_advanced_action: milling and style are required")
            return WebsocketError([SocketErrors.INVALID_INPUT.value, "milling and style are required"]).to_json()
        try:
            count = int(count)
            if count < 0:
                raise ValueError("count must be non-negative")
        except (TypeError, ValueError) as e:
            keyme.log.warning(f"inventory_advanced_action: validation failed (count): {e}")
            return WebsocketError([SocketErrors.INVALID_INPUT.value, str(e)]).to_json()

        force = data.get("force")
        if action == 'add_magazine':
            if not force and mag_stock:
                keyme.log.warning(f"inventory_advanced_action: add_magazine but slot {magazine} already has key data")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "Cannot add magazine: slot already has key data. Use Replace Keys or Replace Magazine."]).to_json()
        else:
            if not force and not mag_stock:
                keyme.log.warning(f"inventory_advanced_action: replace on empty slot {magazine}")
                return WebsocketError([SocketErrors.INVALID_INPUT.value, "Slot is empty. Use Add Magazine."]).to_json()

        capacity = interface.get_magazine_capacity(milling, style)
        if capacity is None:
            keyme.log.error(f"inventory_advanced_action: missing capacity for {milling}-{style}")
            return WebsocketError([SocketErrors.OTHER.value, f"Missing magazine capacity for {milling}-{style}"]).to_json()
        if not force and count > capacity:
            keyme.log.warning(f"inventory_advanced_action: count {count} exceeds capacity {capacity}")
            return WebsocketError([
                SocketErrors.INVALID_INPUT.value,
                f"Count {count} exceeds max capacity {capacity} for {milling}-{style}",
            ]).to_json()

        interface.export_stock(backup=True)
        key_data = {
            "milling": milling,
            "name": style,
            "count": count,
            "display_name": "Test",
            "magazine": magazine,
        }
        from inventory.magazine_actions import MagazineAction
        keep_qr_code = (action == 'replace_keys')
        update_reason = MagazineAction.REFILL if action == 'replace_keys' else None
        success = interface.change_magazine(magazine, key_data, keep_qr_code=keep_qr_code, update_reason=update_reason)
        if not success:
            keyme.log.error(f"inventory_advanced_action: action {action} failed for magazine {magazine}")
            return WebsocketError([SocketErrors.OTHER.value, "Action failed"]).to_json()
        err = _inventory_run_update_pricing_if_needed(interface, data)
        return err if err is not None else WebsocketSuccess({}).to_json()

    except keyme.ipc.exceptions.TimeoutException:
        keyme.log.error("inventory_advanced_action: Inventory not responding (timeout)")
        return WebsocketError([SocketErrors.IPC_TIMED_OUT.value, "Inventory not responding"]).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_advanced_action: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()


def inventory_update_api_pricing(data):
    """Run API and pricing update (same as after inventory edits). Only on kiosk."""
    keyme.log.info("WS: requesting inventory_update_api_pricing")
    if not getattr(keyme.config, "IS_KIOSK", False):
        return WebsocketSuccess({"message": "Only runs on kiosk"}).to_json()
    try:
        from util.update_pricing import update_pricing
        if update_pricing() != 0:
            keyme.log.error("inventory_update_api_pricing: update_pricing returned non-zero")
            return WebsocketError([SocketErrors.OTHER.value, "Update pricing failed"]).to_json()
        return WebsocketSuccess({}).to_json()
    except Exception as e:
        keyme.log.error(f"inventory_update_api_pricing: {e}")
        return WebsocketError([SocketErrors.OTHER.value, "Operation failed"]).to_json()

