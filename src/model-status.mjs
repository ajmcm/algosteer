export const SETUP_MESSAGE = 'Setting up AlgoSteer: first use downloads the embedding model (~175 MB) and may take a few minutes. WebGPU is required. Posts are processed locally.';

// Transformers reports progress per asset, not for the entire model download.
export function createDownloadReporter(send) {
  let last='';
  return event => {
    if(event?.status==='done'){
      send({phase:'preparing',message:'Loading model assets and preparing local inference… More downloads may follow.'});
      return;
    }
    if(!['initiate','download','progress'].includes(event?.status))return;
    const value=Number(event.progress);
    const percent=event.status==='progress' && Number.isFinite(value)
      ? Math.min(100,Math.max(0,Math.floor(value/5)*5)) : null;
    const key=`${event.file??''}:${percent}`;
    if(key===last)return;
    last=key;
    send({phase:'downloading',progress:percent,message:percent===null
      ? 'Downloading embedding model assets… First use is about 175 MB. Posts stay on this device.'
      : `Downloading embedding model assets… ${percent}% of the current file. More files may follow. Posts stay on this device.`});
  };
}

export function activeInferenceMessage(inference) {
  return inference?.phase==='ready' ? 'Processing post locally…' : inference?.message || SETUP_MESSAGE;
}
