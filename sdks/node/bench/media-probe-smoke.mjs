import { createRhinoQMediaContext } from '../dist/index.js';
const input=process.argv[2];if(!input)throw new Error('media probe smoke requires a file path');
const probe=await createRhinoQMediaContext({}).probe(input);
if(!probe.streams.length)throw new Error('ffprobe returned no streams');
console.log(JSON.stringify(probe,null,2));
