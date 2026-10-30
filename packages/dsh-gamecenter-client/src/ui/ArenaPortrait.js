// @ts-check
// @ts-expect-error supplied by DSH
import {createElement as h} from 'react';
import {ARENA_PERSONAS} from '@dsh-gamecenter/protocol';
// @ts-expect-error esbuild embeds the project-owned image as a data URL
import portraits from '../../../../games/cat-arena/assets/personas/arena-portraits.webp';
/** @param {{personaId:string,className?:string}} props */
export function ArenaPortrait({personaId,className=''}){const p=ARENA_PERSONAS.find(p=>p.id===personaId)??ARENA_PERSONAS[0];return h('span',{role:'img','aria-label':`${p.model} / ${p.name}`,'data-arena-portrait':p.id,className:'gc-arena-portrait '+className,style:{backgroundImage:`url("${portraits}")`,backgroundPosition:`${p.cell%3*50}% ${Math.floor(p.cell/3)*100}%`}});}
