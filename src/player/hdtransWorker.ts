// hdTrans worker. Asset URLs come with init: the app base is only known on the main thread.
import type { HdTrans, Speech } from 'hdtrans';
import type { TranslationJob } from './assTranslate';

interface InitMessage {
  type: 'init';
  engineUrl: string;
  runtimeUrl: string;
  dictUrl: string;
}

interface TranslateMessage {
  type: 'translate';
  id: number;
  jobs: TranslationJob[];
}

interface Engine {
  FS: { writeFile(path: string, data: Uint8Array): void };
}

/** hdtrans dist/runtime.js. */
interface Runtime {
  HdTrans: {
    init(options: {
      module: Engine;
      directories: string[];
      speech: Speech;
      wrapped: boolean;
    }): Promise<HdTrans>;
  };
}

// Typed minimally to avoid pulling in the conflicting "webworker" lib alongside "dom".
const ctx = globalThis as unknown as {
  postMessage(msg: unknown): void;
  addEventListener(
    type: 'message',
    cb: (e: MessageEvent<InitMessage | TranslateMessage>) => void,
  ): void;
};

let translator: Promise<HdTrans> | null = null;

async function load(msg: InitMessage): Promise<HdTrans> {
  const [{ default: createEngine }, runtime, dict] = await Promise.all([
    import(/* @vite-ignore */ msg.engineUrl) as Promise<{ default: () => Promise<Engine> }>,
    import(/* @vite-ignore */ msg.runtimeUrl) as Promise<Runtime>,
    fetch(msg.dictUrl).then((res) => {
      if (!res.ok) throw new Error(`hdTrans dictionary fetch failed (${res.status})`);
      return res.arrayBuffer();
    }),
  ]);
  const engine = await createEngine();
  engine.FS.writeFile('/dicts.hdsnap', new Uint8Array(dict));
  return runtime.HdTrans.init({
    module: engine,
    directories: ['/dicts.hdsnap'],
    speech: 'soft',
    wrapped: true,
  });
}

ctx.addEventListener('message', async (e) => {
  const msg = e.data;
  if (msg?.type === 'init') {
    translator ??= load(msg);
    translator.then(
      () => ctx.postMessage({ type: 'ready' }),
      (err) => ctx.postMessage({ type: 'fatal', message: (err as Error).message }),
    );
    return;
  }
  if (msg?.type !== 'translate') return;
  try {
    if (!translator) throw new Error('hdTrans worker not initialised');
    const t = await translator;
    const lines = msg.jobs.map((job) =>
      t.translate(job.text, { wrapped: true, speech: 'soft', context: job.context }),
    );
    ctx.postMessage({ type: 'result', id: msg.id, lines });
  } catch (err) {
    ctx.postMessage({ type: 'error', id: msg.id, message: (err as Error).message });
  }
});
