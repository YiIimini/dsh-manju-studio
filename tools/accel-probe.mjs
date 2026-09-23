/** 验证加速机制表：机制决定接线与步数，不开放自由组合。 */
import { spawnSync } from 'node:child_process'

const PY = 'D:\\Ai\\ComfyUI\\standalone-env\\python.exe'
const script = String.raw`
import importlib.util, os, tempfile
spec = importlib.util.spec_from_file_location('manju', r'C:\Users\Administrator\.dsh\skills\manju-render\scripts\manju.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
tmp = tempfile.mkdtemp()
imgs = []
for i in range(2):
    p = os.path.join(tmp, f'r{i}.png'); open(p,'wb').write(b'\x89PNG\r\n\x1a\n'); imgs.append(p)
fails = []
def ok(c, msg):
    print(('  PASS ' if c else '  FAIL ') + msg)
    if not c: fails.append(msg)
def build(**kw):
    base = dict(id='p', prompt='x', width=1344, height=768, length=124, steps=8, seed=1,
                mode='r2v', ref_images=imgs)
    base.update(kw)
    g, meta = m.build_graph(base, style='', cfg=None)
    return g, meta, {v['class_type']: k for k, v in g.items()}

print('=== 机制 -> 接线 ===')
for accel, steps_want, want_sampler in [
        ('pdd8', 8, 'euler'), ('pdd6', 6, 'euler'), ('pdd4', 4, 'euler'),
        ('turbo4', 4, 'MiniMaxH3TurboSampler')]:
    g, meta, ty = build(accel=accel)
    if accel.startswith('pdd'):
        ok('MiniMaxH3PDDAccApply' in ty, accel + ' 用 PDD Apply')
        ok(ty.get('MiniMaxH3PDDAccApply') is not None
           and g[ty['MiniMaxH3PDDAccApply']]['inputs']['nfe'] == str(steps_want),
           accel + ' nfe=' + str(steps_want))
        ok('MiniMaxH3TurboSampler' not in ty, accel + ' 不混入 Turbo 节点')
        ok(g[ty['SamplerCustomAdvanced']]['inputs']['sigmas'] == [ty['MiniMaxH3PDDAccApply'], 1],
           accel + ' 采样器吃 PDD 的 SIGMAS')
    else:
        ok('MiniMaxH3TurboLoRA' in ty, accel + ' 用 Turbo LoRA 节点')
        ok('MiniMaxH3TurboSampler' in ty, accel + ' 用配套 Turbo Sampler')
        ok('MiniMaxH3PDDAccApply' not in ty, accel + ' 不混入 PDD 节点')
        bs = ty['BasicScheduler']
        # 知识库点名的易漏连线：LoRA 输出必须同时接 Guider 与 Scheduler
        ok(g[bs]['inputs']['model'] == [ty['MiniMaxH3SigmaShift'], 0],
           accel + ' Scheduler 吃 SigmaShift 后的模型（不经原模型）')
        ok(g[bs]['inputs']['steps'] == 4, accel + ' 步数固定为 4（训练档）')
        ok(g[bs]['inputs']['scheduler'] == 'simple', accel + ' 排程 simple（官方要求）')
        ok(g[ty['SamplerCustomAdvanced']]['inputs']['sampler'] == [ty['MiniMaxH3TurboSampler'], 0],
           accel + ' 采样器接的是 Turbo Sampler 而不是 KSamplerSelect')
        ok(g[ty['SamplerCustomAdvanced']]['inputs']['sigmas'] == [bs, 0],
           accel + ' sigmas 接 BasicScheduler')
    ok(meta['accel'].startswith('PDD') or meta['accel'].startswith('Turbo'),
       accel + ' meta 如实报告：' + meta['accel'])

print('=== accel=none 退路 ===')
g, meta, ty = build(accel='none')
ok('LoraLoaderModelOnly' in ty and 'BasicScheduler' in ty, 'none 用普通 LoRA + BasicScheduler')
ok(meta['accel'].startswith('plain-lora'), 'meta 报告 plain-lora')
ok('MiniMaxH3TurboSampler' not in ty and 'MiniMaxH3PDDAccApply' not in ty, 'none 无加速节点')

print('=== 非法机制名被夹回 none ===')
g, meta, ty = build(accel='turbo99')
ok('LoraLoaderModelOnly' in ty, '未知机制名回退到 none 路径')

print('=== int8 VAE ===')
g, meta, ty = build(accel='pdd8')
ok(g['5']['inputs']['vae_name'].endswith('int8_convrot.safetensors'), '默认用 int8 视频 VAE')
ok(meta['vae'] == 'int8', 'meta 报告 vae=int8')
g, meta, ty = build(accel='pdd8', vaeInt8=False)
ok(g['5']['inputs']['vae_name'].endswith('fp16.safetensors'), 'vaeInt8=False 时回 fp16')
ok(meta['vae'] == 'fp16', 'meta 报告 vae=fp16')

print('=== 音频 VAE 没被 int8 影响（别接反）===')
g, meta, ty = build(accel='pdd8')
ok(g['6']['inputs']['vae_name'].endswith('audio_vae_fp32.safetensors'), '音频仍走 fp32 音频 VAE')

print()
print('FAILED %d' % len(fails) if fails else '全部通过')
`
const r = spawnSync(PY, ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })
process.stdout.write(r.stdout || '')
if (r.stderr) process.stdout.write('STDERR: ' + r.stderr.slice(0, 900))
process.exit(r.status || 0)
