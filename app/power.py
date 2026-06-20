from __future__ import annotations

import ctypes
import platform
import subprocess


def suspend_computer() -> None:
    system = platform.system()
    if system == "Windows":
        ctypes.windll.PowrProf.SetSuspendState(False, True, False)
    elif system == "Darwin":
        subprocess.run(["pmset", "sleepnow"], check=True)
    elif system == "Linux":
        subprocess.run(["systemctl", "suspend"], check=True)
    else:
        raise RuntimeError(f"Suspend not supported on {system}")
