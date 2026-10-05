import {z} from 'zod';

export const displayDefaults={
  displayMode:'floating',popupStyle:'center',position:'bottom-right',
  randomPopupEnabled:true,initialDelaySeconds:5,minPopupDelaySeconds:10,maxPopupDelaySeconds:10,
  trigger:'hybrid',scrollThreshold:20,scrollTriggerPixels:150,minPageViews:2,displayDurationSeconds:22,autoClose:false,repeatCycle:true,
  rotationIntervalSeconds:10,dismissCooldownMinutes:0,dismissCooldownSession:false,
  maxAdsPerSession:0,maxImpressionsPerCampaignPerSession:0,
  showMobile:true,showDesktop:true,allowFloating:true,pauseAds:false,creativeOnly:false
};
export const displaySettingsSchema=z.object({
  displayMode:z.enum(['floating','inline','banner','native']).optional(),
  popupStyle:z.enum(['floating','center','mixed']).optional(),
  position:z.enum(['bottom-right','bottom-left','bottom-center']).optional(),
  randomPopupEnabled:z.boolean().optional(),initialDelaySeconds:z.number().int().min(5).max(120).optional(),
  minPopupDelaySeconds:z.number().int().min(5).max(120).optional(),maxPopupDelaySeconds:z.number().int().min(5).max(300).optional(),
  trigger:z.enum(['time','scroll','engagement','hybrid','pageview']).optional(),
  scrollThreshold:z.number().int().min(20).max(90).optional(),scrollTriggerPixels:z.number().int().min(0).max(2000).optional(),minPageViews:z.number().int().min(2).max(10).optional(),
  autoClose:z.boolean().optional(),repeatCycle:z.boolean().optional(),displayDurationSeconds:z.number().int().min(15).max(30).optional(),rotationIntervalSeconds:z.number().int().min(10).max(3600).optional(),
  dismissCooldownMinutes:z.number().min(0).max(60).optional(),dismissCooldownSession:z.boolean().optional(),
  maxAdsPerSession:z.number().int().min(0).max(3).optional(),maxImpressionsPerCampaignPerSession:z.number().int().min(0).max(3).optional(),
  showMobile:z.boolean().optional(),showDesktop:z.boolean().optional(),allowFloating:z.boolean().optional(),pauseAds:z.boolean().optional(),creativeOnly:z.boolean().optional()
}).strict();
export function zoneDisplaySettings(zone){
  try{return {...displayDefaults,...displaySettingsSchema.parse(JSON.parse(zone.display_settings||'{}'))};}
  catch{return {...displayDefaults};}
}
export function mergeDisplaySettings(zone,input){
  const next={...zoneDisplaySettings(zone),...displaySettingsSchema.parse(input)};
  if(next.maxPopupDelaySeconds<next.minPopupDelaySeconds)throw Object.assign(new Error('Maximum delay must be at least the minimum delay'),{status:400});
  return next;
}
