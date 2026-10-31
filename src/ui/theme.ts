type Theme='light'|'dark';
const THEME_KEY='podcut:theme';
export function mountThemeControls():void {
 const choices=document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]');
 function apply(theme:Theme,save=false){
  document.documentElement.dataset.theme=theme;
  document.documentElement.style.colorScheme=theme;
  choices.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===theme)));
  if(save){
   try{localStorage.setItem(THEME_KEY,theme);}catch{/* A private window can still switch themes. */}
   const url=new URL(location.href);if(url.searchParams.has('theme')){url.searchParams.delete('theme');history.replaceState(history.state,'',url);}
  }
  window.dispatchEvent(new CustomEvent('podcut:themechange',{detail:{theme}}));
 }
 apply(document.documentElement.dataset.theme==='dark'?'dark':'light');
 choices.forEach(button=>button.addEventListener('click',()=>apply(button.dataset.themeChoice==='dark'?'dark':'light',true)));
 window.addEventListener('storage',event=>{if(event.key===THEME_KEY&&(event.newValue==='light'||event.newValue==='dark'))apply(event.newValue);});
}
