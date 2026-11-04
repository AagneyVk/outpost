import fs from 'node:fs/promises';
await fs.mkdir('public/vendor/novnc',{recursive:true});
for(const item of ['core','vendor','LICENSE.txt','AUTHORS'])await fs.cp('node_modules/@novnc/novnc/'+item,'public/vendor/novnc/'+item,{recursive:true});
console.log('Copied pinned noVNC 1.7 display client and licence notices.');
