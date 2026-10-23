"""Cross-process save lock. Keep protocol identical to app/src/main/program-lock.ts."""
from contextlib import contextmanager
import errno
import os
from pathlib import Path
import re
import time
import uuid


def alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION; never terminate
        if not handle:
            return ctypes.get_last_error() != 87  # invalid PID; access denied is treated as alive
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError as error:
        return error.errno != errno.ESRCH


@contextmanager
def program_lock(target, timeout=15):
    lock = Path(str(target) + '.lock')
    owner = f'{os.getpid()}-{uuid.uuid4()}'
    until = time.monotonic() + timeout
    while True:
        try:
            lock.mkdir()
            try:
                (lock / owner).touch(exist_ok=False)
            except OSError:
                lock.rmdir()
                raise
            break
        except PermissionError:
            # Windows: a lock folder another writer has just removed stays "delete pending" while any
            # handle is open, and mkdir is refused with access denied. That is a busy lock, not a
            # failure; only a refusal that outlasts the timeout is reported as itself.
            if os.name != 'nt':
                raise
            if time.monotonic() >= until:
                raise
            time.sleep(.025)
        except FileExistsError:
            try:
                entries = list(lock.iterdir())
                if len(entries) == 1 and re.fullmatch(r'\d+-[\da-f-]+', entries[0].name) and not alive(int(entries[0].name.split('-')[0])):
                    entries[0].unlink()
                    lock.rmdir()
                elif not entries and time.time() - lock.stat().st_mtime > 30:
                    lock.rmdir()
            except OSError:
                pass
            if time.monotonic() >= until:
                raise OSError('Another program save is still in progress. The batch was not applied; retry it.')
            time.sleep(.025)
    try:
        yield
    finally:
        (lock / owner).unlink(missing_ok=True)
        try:
            lock.rmdir()
        except OSError:
            pass
