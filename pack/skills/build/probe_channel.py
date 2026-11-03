"""Child-side transport only. Parent records requests/replies; this shim is not a secret boundary."""
import json
import os
import sys
import threading

_lock = threading.Lock()
_fd = None


def llm(prompt, *args, **kwargs):
    global _fd
    def text(value):
        if isinstance(value, str): return value
        if isinstance(value, (int, float)): return str(value)
        if isinstance(value, list): return ' '.join(text(v) for v in value)
        if isinstance(value, dict): return ' '.join(text(v) for v in value.values())
        return ''
    request = {'op': 'llm', 'prompt': str(prompt), 'extra': ' '.join(text(v) for v in args) + ' ' + ' '.join(text(v) for v in kwargs.values())}
    data = (json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8')
    if len(data) > 256 * 1024:
        raise ValueError('model request exceeds channel limit')
    with _lock:
        if _fd is None:
            if os.name == 'nt':
                import msvcrt
                _fd = msvcrt.open_osfhandle(int(os.environ['HUMANSTUDY_PROBE_HANDLE']), os.O_WRONLY | os.O_BINARY)
            else:
                _fd = int(os.environ['HUMANSTUDY_PROBE_FD'])
        while data:
            data = data[os.write(_fd, data):]
        reply = sys.stdin.buffer.readline(8193)
        if not reply or len(reply) > 8192:
            raise RuntimeError('parent model channel closed')
        value = json.loads(reply)['reply']
        if not isinstance(value, str):
            raise ValueError('invalid model reply')
        return value
