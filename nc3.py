"""Minimal reader for netCDF-3 classic / 64-bit-offset files (numpy only)."""
import struct
import numpy as np

_TYPES = {1: ('b', 1), 2: ('c', 1), 3: ('>i2', 2), 4: ('>i4', 4), 5: ('>f4', 4), 6: ('>f8', 8)}


class NC3:
    def __init__(self, data: bytes):
        self.b = data
        if data[:3] != b'CDF':
            raise ValueError('not netCDF-3: ' + data[:200].decode('latin1', 'replace'))
        self.ver = data[3]
        self.p = 4
        self.numrecs = self._i()
        self.dims = self._dims()
        self.attrs = self._attrs()
        self.vars = self._vars()

    def _i(self):
        v = struct.unpack('>i', self.b[self.p:self.p + 4])[0]; self.p += 4; return v

    def _off(self):
        if self.ver == 2:
            v = struct.unpack('>q', self.b[self.p:self.p + 8])[0]; self.p += 8; return v
        return self._i()

    def _name(self):
        n = self._i(); s = self.b[self.p:self.p + n].decode('latin1'); self.p += (n + 3) & ~3; return s

    def _dims(self):
        tag, n = self._i(), self._i()
        out = []
        for _ in range(n):
            out.append((self._name(), self._i()))
        return out

    def _attrs(self):
        tag, n = self._i(), self._i()
        out = {}
        for _ in range(n):
            name = self._name(); t = self._i(); cnt = self._i()
            dt, sz = _TYPES[t]
            raw = self.b[self.p:self.p + cnt * sz]; self.p += (cnt * sz + 3) & ~3
            out[name] = raw.decode('latin1').rstrip('\x00') if t == 2 else np.frombuffer(raw, dt).tolist()
        return out

    def _vars(self):
        tag, n = self._i(), self._i()
        out = {}
        for _ in range(n):
            name = self._name(); nd = self._i(); dimids = [self._i() for _ in range(nd)]
            attrs = self._attrs(); t = self._i(); vsize = self._i(); begin = self._off()
            out[name] = dict(dimids=dimids, attrs=attrs, type=t, vsize=vsize, begin=begin)
        return out

    def recsize(self):
        return sum(v['vsize'] for v in self.vars.values() if v['dimids'] and self.dims[v['dimids'][0]][1] == 0)

    def get(self, name, masked=True):
        v = self.vars[name]
        dt, sz = _TYPES[v['type']]
        shape = [self.dims[d][1] for d in v['dimids']]
        isrec = bool(shape) and shape[0] == 0
        if isrec:
            shape[0] = self.numrecs
            inner = int(np.prod(shape[1:])) if len(shape) > 1 else 1
            rs = self.recsize()
            if len([1 for x in self.vars.values() if x['dimids'] and self.dims[x['dimids'][0]][1] == 0]) == 1:
                rs = inner * sz
            arr = np.empty(shape, dtype=dt)
            flat = arr.reshape(self.numrecs, -1)
            for r in range(self.numrecs):
                o = v['begin'] + r * rs
                flat[r] = np.frombuffer(self.b[o:o + inner * sz], dt)
        else:
            cnt = int(np.prod(shape)) if shape else 1
            arr = np.frombuffer(self.b[v['begin']:v['begin'] + cnt * sz], dt).reshape(shape)
        arr = arr.astype('f8') if v['type'] in (3, 4, 5, 6) else arr
        if masked and v['type'] in (5, 6):
            fv = v['attrs'].get('_FillValue') or v['attrs'].get('missing_value')
            if fv is not None:
                fv = fv[0] if isinstance(fv, list) else fv
                arr = np.where(np.isclose(arr, fv), np.nan, arr)
            arr = np.where(np.abs(arr) > 1e20, np.nan, arr)
        return arr
