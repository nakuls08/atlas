import type { BoardModel } from '../model';
import { start } from './main';

/** Page entry for a registry board: the model arrives laid out in the page. Org graphs use src/orgview. */
start(JSON.parse(document.getElementById('atlas-model')!.textContent!) as BoardModel);
