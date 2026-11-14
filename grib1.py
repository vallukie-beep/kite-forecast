"""Minimal GRIB edition 1 reader (numpy only) for KNMI HARMONIE files.

Supports what HARMONIE-AROME P1 uses: regular lat/lon grids (data representation 0),
simple grid-point packing, optional bitmap. Anything else raises NotImplementedError,
so a format change fails loudly instead of producing wrong maps.
"""
import datetime as dt

import numpy as np


def _u(b):  # unsigned big-endian int
    return int.from_bytes(b, "big")


def _s(b):  # GRIB1 sign-magnitude signed int
    v = int.from_bytes(b, "big")
    top = 1 << (8 * len(b) - 1)
    return -(v - top) if v & top else v


def _ibm(b):  # IBM single precision float
    v = int.from_bytes(b, "big")
    if v == 0:
        return 0.0
    sign = -1.0 if v >> 31 else 1.0
    exp = (v >> 24) & 0x7F
    mant = v & 0xFFFFFF
    return sign * mant / float(1 << 24) * 16.0 ** (exp - 64)


class Message:
    """One GRIB1 message. .param, .levtype, .level, .ref (datetime), .valid (datetime),
    .tri (time range indicator), .p1, .p2 (hours), .grid (dict), .values() -> 2D array (south row first)."""

    def __init__(self, buf, off):
        if buf[off:off + 4] != b"GRIB":
            raise ValueError("not a GRIB message")
        self.length = _u(buf[off + 4:off + 7])
        if buf[off + 7] != 1:
            raise NotImplementedError(f"GRIB edition {buf[off + 7]}")
        self._buf, self._off = buf, off
        p = off + 8
        pds = buf[p:p + _u(buf[p:p + 3])]
        self.table = pds[3]
        flag = pds[7]
        self.param, self.levtype = pds[8], pds[9]
        self.level = _u(pds[10:12])
        year = (pds[24] - 1) * 100 + pds[12]
        self.ref = dt.datetime(year, pds[13], pds[14], pds[15], pds[16], tzinfo=dt.timezone.utc)
        unit, p1, p2, self.tri = pds[17], pds[18], pds[19], pds[20]
        mult = {0: 1 / 60, 1: 1, 2: 24, 10: 3, 11: 6, 12: 12, 13: 0.25, 14: 0.5}.get(unit)
        if mult is None:
            raise NotImplementedError(f"time unit {unit}")
        if self.tri == 10:
            p1, p2 = (p1 << 8) | p2, 0
        self.p1, self.p2 = p1 * mult, p2 * mult
        lead = self.p2 if self.tri in (2, 3, 4, 5) else self.p1
        self.valid = self.ref + dt.timedelta(hours=lead)
        self.D = _s(pds[26:28])
        p += len(pds)
        self.grid = None
        if flag & 0x80:
            gds = buf[p:p + _u(buf[p:p + 3])]
            self.grid = self._gds(gds)
            p += len(gds)
        self._bitmap = None
        if flag & 0x40:
            ln = _u(buf[p:p + 3])
            if _u(buf[p + 4:p + 6]) != 0:
                raise NotImplementedError("predefined bitmap")
            self._bitmap = (p + 6, ln - 6)
            p += ln
        self._bds = p

    @staticmethod
    def _gds(g):
        rep = g[5]
        if rep != 0:
            raise NotImplementedError(f"grid type {rep} (only regular lat/lon is supported)")
        ni, nj = _u(g[6:8]), _u(g[8:10])
        la1, lo1 = _s(g[10:13]) / 1000, _s(g[13:16]) / 1000
        la2, lo2 = _s(g[17:20]) / 1000, _s(g[20:23]) / 1000
        scan = g[27]
        return dict(ni=ni, nj=nj, la1=la1, lo1=lo1, la2=la2, lo2=lo2, scan=scan,
                    lon0=min(lo1, lo2), lat0=min(la1, la2),
                    dlon=abs(lo2 - lo1) / (ni - 1), dlat=abs(la2 - la1) / (nj - 1))

    @property
    def key(self):
        return (self.param, self.levtype, self.level)

    def values(self):
        b, p = self._buf, self._bds
        ln = _u(b[p:p + 3])
        flag = b[p + 3]
        if flag & 0xC0:
            raise NotImplementedError("only simple grid-point packing is supported")
        E = _s(b[p + 4:p + 6])
        R = _ibm(b[p + 6:p + 10])
        nbits = b[p + 10]
        g = self.grid
        npts = g["ni"] * g["nj"]
        if self._bitmap:
            bo, bl = self._bitmap
            mask = np.unpackbits(np.frombuffer(b, np.uint8, bl, bo))[:npts].astype(bool)
            nvals = int(mask.sum())
        else:
            mask, nvals = None, npts
        scale = 2.0 ** E / 10.0 ** self.D
        if nbits == 0:
            vals = np.full(nvals, R / 10.0 ** self.D)
        else:
            raw = np.frombuffer(b, np.uint8, ln - 11, p + 11)
            bits = np.unpackbits(raw)[:nvals * nbits].reshape(nvals, nbits)
            ints = bits.dot(1 << np.arange(nbits - 1, -1, -1, dtype=np.int64))
            vals = (R + ints * 2.0 ** E) / 10.0 ** self.D
            del scale
        out = np.full(npts, np.nan)
        if mask is not None:
            out[mask] = vals
        else:
            out[:] = vals
        a = out.reshape(g["nj"], g["ni"]) if not (g["scan"] & 0x20) else out.reshape(g["ni"], g["nj"]).T
        if g["scan"] & 0x80:          # points scan west-ward
            a = a[:, ::-1]
        if not (g["scan"] & 0x40):    # rows scan south-ward: flip so row 0 is the south
            a = a[::-1, :]
        return a


def messages(data):
    """Yield every GRIB1 message in a bytes object."""
    off, n = 0, len(data)
    while True:
        off = data.find(b"GRIB", off)
        if off < 0 or off + 8 > n:
            return
        m = Message(data, off)
        yield m
        off += m.length
