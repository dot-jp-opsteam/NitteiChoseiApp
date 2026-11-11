/* 面談申請の時間帯。ブラウザとAPIで同じ判定を使う。既存データは変換しない。 */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.InterviewPreferences=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
  var STEP=1800000;
  function normalize(groups){
    if(!Array.isArray(groups)||!groups.length||groups.length>600)throw Error('希望候補が不正です');
    var total=0;
    return groups.map(function(g){
      if(!g||!Array.isArray(g.slots)||!g.slots.length)throw Error('希望候補が不正です');
      total+=g.slots.length;if(total>600)throw Error('希望候補が多すぎます');
      var slots=g.slots.map(function(s){var t=new Date(s).getTime();if(!Number.isFinite(t)||t%STEP)throw Error('希望候補の時刻が不正です');return new Date(t).toISOString();});
      if(new Set(slots).size!==slots.length)throw Error('希望候補が重複しています');
      slots.sort(function(a,b){return new Date(a)-new Date(b);});
      return {slots:slots,mode:g.mode==='point'?'point':'slot'};
    });
  }
  function segments(g){
    var runs=[];(g.slots||[]).slice().sort(function(a,b){return new Date(a)-new Date(b);}).forEach(function(s){var t=+new Date(s),last=runs[runs.length-1];if(last&&t===last.last+STEP){last.last=t;last.count++;}else runs.push({start:t,last:t,count:1});});
    return runs.map(function(r){return {start:r.start,end:r.last+(g.mode==='point'&&r.count>1?0:STEP)};});
  }
  function fits(g,start,duration){var s=+new Date(start),e=s+duration*60000;return Number.isFinite(s)&&duration>0&&segments(g).some(function(r){return s>=r.start&&e<=r.end;});}
  function conflicts(groups){
    var out=[];
    groups.forEach(function(g,i){
      var source=segments(g),remaining=source.map(function(r){return {start:r.start,end:r.end};}),against=[];
      groups.slice(0,i).forEach(function(prev,j){var cuts=segments(prev);if(!source.some(function(r){return cuts.some(function(c){return r.start<c.end&&r.end>c.start;});}))return;against.push(j);
        cuts.forEach(function(c){remaining=remaining.reduce(function(acc,r){if(r.start>=c.end||r.end<=c.start)acc.push(r);else{if(r.start<c.start)acc.push({start:r.start,end:c.start});if(r.end>c.end)acc.push({start:c.end,end:r.end});}return acc;},[]);});
      });
      if(against.length)out.push({index:i,against:against,duplicate:groups.slice(0,i).some(function(p){return JSON.stringify(segments(p))===JSON.stringify(source);}),remaining:remaining.map(function(r){return {start:new Date(r.start).toISOString(),end:new Date(r.end).toISOString()};})});
    });return out;
  }
  function groups(iv){
    if(Array.isArray(iv.preference_groups)&&iv.preference_groups.length)return iv.preference_groups.map(function(g){return {slots:g.slots.slice(),mode:'slot'};});
    var choices=Array.isArray(iv.choices)?iv.choices:[iv.choice1,iv.choice2,iv.choice3].filter(Boolean),first=new Map();
    choices.forEach(function(s,i){if(s&&!first.has(s))first.set(s,i);});
    function day(s){var d=new Date(s);if(d.getHours()===0&&d.getMinutes()===0)d=new Date(+d-1);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
    var runs=[];
    Array.from(first.keys()).sort(function(a,b){return new Date(a)-new Date(b);}).forEach(function(s){
      var key=day(s),all=(iv.all_day||[]).indexOf(key)>=0,last=runs[runs.length-1];
      if(all){var existing=runs.find(function(r){return r.allDay&&r.key===key;});if(existing){existing.slots.push(s);return;}}
      if(!all&&last&&!last.allDay&&last.key===key&&new Date(s)-new Date(last.slots[last.slots.length-1])===STEP)last.slots.push(s);
      else runs.push({slots:[s],key:key,allDay:all,mode:iv.choice_mode==='slot'?'slot':'point'});
    });
    return runs.sort(function(a,b){return Math.min.apply(null,a.slots.map(function(s){return first.get(s);}))-Math.min.apply(null,b.slots.map(function(s){return first.get(s);}));});
  }
  return {normalize:normalize,segments:segments,fits:fits,conflicts:conflicts,groups:groups};
});
