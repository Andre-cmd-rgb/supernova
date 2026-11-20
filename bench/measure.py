#!/usr/bin/env python3
"""Measure what a browser costs while it runs: energy, CPU, GPU engines, memory.

Samples once a second for --seconds and prints one JSON object:
  - RAPL energy (package, core, uncore = iGPU, psys = whole platform) in watts
  - CPU time of every process under the given root PIDs (cores busy)
  - i915 GPU engine time per engine (render, video, video-enhance, copy) from
    DRM fdinfo, for the browser tree and for the compositor separately
  - PSS memory of the tree at the end (MiB), and the peak seen
  - whether the NVIDIA card ever left runtime suspend
No root needed, except reading RAPL (made readable with chmod).
"""
import argparse, glob, json, os, re, time

CLK = os.sysconf("SC_CLK_TCK")
RAPL = {}
for d in glob.glob("/sys/class/powercap/intel-rapl:*"):
    try:
        name = open(f"{d}/name").read().strip()
    except OSError:
        continue
    if "mmio" in d:
        continue
    RAPL[name] = d


def rapl_read():
    out = {}
    for name, d in RAPL.items():
        try:
            out[name] = (int(open(f"{d}/energy_uj").read()), int(open(f"{d}/max_energy_range_uj").read()))
        except OSError:
            pass
    return out


def children_map():
    kids = {}
    for p in os.listdir("/proc"):
        if not p.isdigit():
            continue
        try:
            stat = open(f"/proc/{p}/stat").read()
        except OSError:
            continue
        ppid = int(stat.rsplit(")", 1)[1].split()[1])
        kids.setdefault(ppid, []).append(int(p))
    return kids


def tree(roots):
    kids = children_map()
    seen, stack = set(), list(roots)
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        stack.extend(kids.get(p, []))
    return seen


def cputime(pid):
    try:
        f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
        return (int(f[11]) + int(f[12])) / CLK
    except (OSError, IndexError):
        return None


ENGINES = ("render", "video", "video-enhance", "copy")


def drm_clients(pid):
    """{client_id: {engine: ns}} for i915 clients held by pid."""
    out = {}
    for fd in glob.glob(f"/proc/{pid}/fdinfo/*"):
        try:
            txt = open(fd).read()
        except OSError:
            continue
        if "drm-driver:\ti915" not in txt and "drm-driver: i915" not in txt:
            continue
        cid = re.search(r"drm-client-id:\s*(\d+)", txt)
        if not cid:
            continue
        eng = {}
        for e in ENGINES:
            m = re.search(rf"^drm-engine-{re.escape(e)}:\s*(\d+)", txt, re.M)
            if m:
                eng[e] = int(m.group(1))
        out[cid.group(1)] = eng
    return out


def pss_mib(pids):
    total = 0
    for p in pids:
        try:
            for line in open(f"/proc/{p}/smaps_rollup"):
                if line.startswith("Pss:"):
                    total += int(line.split()[1])
                    break
        except OSError:
            pass
    return total / 1024


def intel_card():
    for c in sorted(glob.glob("/sys/class/drm/card?")):
        try:
            if open(f"{c}/device/vendor").read().strip() == "0x8086":
                return c
        except OSError:
            pass
    return None


INTEL = intel_card()


def gt():
    """(actual GPU MHz now, RC6 residency ms so far) of the Intel iGPU."""
    try:
        return int(open(f"{INTEL}/gt_act_freq_mhz").read()), int(open(f"{INTEL}/power/rc6_residency_ms").read())
    except (OSError, TypeError):
        return 0, 0


def nvidia_status():
    for c in glob.glob("/sys/class/drm/card?"):
        try:
            if open(f"{c}/device/vendor").read().strip() == "0x10de":
                return open(f"{c}/device/power/runtime_status").read().strip()
        except OSError:
            pass
    return None


def pid_of(name):
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                if open(f"/proc/{p}/comm").read().strip() == name:
                    return int(p)
            except OSError:
                pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=int, action="append", default=[], help="root PID of the browser")
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--label", default="")
    ap.add_argument("--compositor", default="Hyprland")
    a = ap.parse_args()

    comp = pid_of(a.compositor)
    cpu_last, cpu_sum = {}, 0.0
    drm_last, drm_sum = {}, {e: 0 for e in ENGINES}
    cdrm_last, cdrm_sum = {}, {e: 0 for e in ENGINES}
    nv_active, samples, peak = 0, 0, 0.0

    def account(pids, last, sums, cpu=True):
        nonlocal cpu_sum
        for p in pids:
            if cpu:
                t = cputime(p)
                if t is not None:
                    if p in last.setdefault("cpu", {}):
                        cpu_sum += max(0.0, t - last["cpu"][p])
                    last["cpu"][p] = t
            for cid, eng in drm_clients(p).items():
                prev = last.setdefault("drm", {}).get(cid)
                if prev is not None:
                    for e, v in eng.items():
                        sums[e] += max(0, v - prev.get(e, v))
                last["drm"][cid] = eng

    detail = {}
    def kind(p):
        try:
            cmd = open(f"/proc/{p}/cmdline").read().split("\0")
        except OSError:
            return "?"
        t = [c for c in cmd if c.startswith("--type=")]
        name = os.path.basename(cmd[0]) if cmd and cmd[0] else "?"
        return name + (":" + t[0][7:] if t else "")
    def per_pid(pids, first=False):
        for p in pids:
            k = kind(p)
            t = cputime(p) or 0
            g = drm_clients(p)
            r = sum(e.get("render", 0) for e in g.values()); v = sum(e.get("video", 0) for e in g.values())
            d = detail.setdefault(p, {"kind": k, "c0": t, "r0": r, "v0": v})
            d.update(c1=t, r1=r, v1=v)
    pids = tree(a.root) if a.root else set()
    per_pid(pids)
    account(pids, drm_last, drm_sum)
    if comp:
        account([comp], cdrm_last, cdrm_sum, cpu=False)
    r0, t0 = rapl_read(), time.monotonic()
    rc6_0 = gt()[1]; freqs = []
    while time.monotonic() - t0 < a.seconds:
        time.sleep(1)
        pids = tree(a.root) if a.root else set()
        account(pids, drm_last, drm_sum)
        if comp:
            account([comp], cdrm_last, cdrm_sum, cpu=False)
        per_pid(pids)
        freqs.append(gt()[0])
        if nvidia_status() not in (None, "suspended"):
            nv_active += 1
        samples += 1
        if samples % 5 == 0:
            peak = max(peak, pss_mib(pids))
    r1, dt = rapl_read(), time.monotonic() - t0
    rc6_pct = (gt()[1] - rc6_0) / 10 / dt
    watts = {}
    for k in r1:
        if k in r0:
            d = r1[k][0] - r0[k][0]
            if d < 0:
                d += r1[k][1]
            watts[k] = round(d / 1e6 / dt, 2)
    end_pss = pss_mib(pids)
    res = {
        "label": a.label,
        "seconds": round(dt, 1),
        "watts": watts,
        "cpu_cores_busy": round(cpu_sum / dt, 3),
        "gpu_busy_pct": {e: round(v / 1e9 / dt * 100, 1) for e, v in drm_sum.items()},
        "compositor_gpu_busy_pct": {e: round(v / 1e9 / dt * 100, 1) for e, v in cdrm_sum.items()},
        "gpu_rc6_pct": round(rc6_pct, 1),
        "gpu_freq_mhz_avg": round(sum(freqs) / max(1, len(freqs))),
        "gpu_work_ghz_s": round(sum(drm_sum.values()) / 1e9 / dt * sum(freqs) / max(1, len(freqs)) / 1000, 3),
        "compositor_work_ghz_s": round(sum(cdrm_sum.values()) / 1e9 / dt * sum(freqs) / max(1, len(freqs)) / 1000, 3),
        "processes": len(pids),
        "pss_mib_end": round(end_pss),
        "pss_mib_peak": round(max(peak, end_pss)),
        "nvidia_awake_samples": nv_active,
        "per_process": sorted(
            [{"kind": d["kind"], "cpu": round((d["c1"]-d["c0"])/dt, 3), "render_pct": round((d["r1"]-d["r0"])/1e9/dt*100, 1), "video_pct": round((d["v1"]-d["v0"])/1e9/dt*100, 1)}
             for d in detail.values() if (d["c1"]-d["c0"]) > 0.01*dt or d["r1"] > d["r0"] or d["v1"] > d["v0"]],
            key=lambda x: -(x["render_pct"] + x["cpu"]*100)),
    }
    print(json.dumps(res))


if __name__ == "__main__":
    main()
