(function(){
 'use strict';
 const search=document.getElementById('talent-search'),role=document.getElementById('talent-role'),cards=[...document.querySelectorAll('.talent-card')];
 const track=(name,candidate)=>{window.va=window.va||function(){(window.vaq=window.vaq||[]).push(arguments);};window.va('event',{name,data:{page:'/browse-talent/',candidate:candidate||'none'}});};
 function filter(){const q=search.value.toLowerCase().trim();let count=0;cards.forEach(c=>{c.hidden=!((role.value==='all'||c.dataset.role===role.value)&&c.dataset.search.toLowerCase().includes(q));if(!c.hidden)count++;});document.getElementById('result-count').textContent=count+' professional'+(count===1?'':'s');document.getElementById('no-results').hidden=count>0;}
 search.addEventListener('input',filter);role.addEventListener('change',filter);document.getElementById('reset-filters').onclick=()=>{search.value='';role.value='all';filter();search.focus();};
 document.querySelectorAll('.request-candidate').forEach(a=>a.addEventListener('click',()=>track('talent_onboarding_open',a.dataset.candidate)));
})();
