import { registerBidder } from '../src/adapters/bidderFactory.js';

const BIDDER_CODE='adpulse';

export const spec={
  code:BIDDER_CODE,
  supportedMediaTypes:['banner','video'],
  isBidRequestValid(bid){
    return !!(bid.params && bid.params.zone);
  },
  buildRequests(validBidRequests,bidderRequest){
    const first=validBidRequests[0];
    const imp=validBidRequests.map((bid,i)=>{
      const sizes=bid.sizes||bid.mediaTypes?.banner?.sizes||[];
      const firstSize=Array.isArray(sizes[0])?sizes[0]:sizes;
      const imp={id:bid.bidId,tagid:bid.params.zone,ext:{adpulse_zone:bid.params.zone}};
      if(bid.mediaTypes?.video){
        imp.video={w:bid.mediaTypes.video.playerSize?.[0]?.[0]||640,h:bid.mediaTypes.video.playerSize?.[0]?.[1]||360,mimes:['video/mp4'],protocols:[2,3,5,6]};
      }else{
        imp.banner={w:firstSize?.[0]||300,h:firstSize?.[1]||250,format:(sizes||[]).map(s=>({w:s[0],h:s[1]}))};
      }
      return imp;
    });
    return {method:'POST',url:(first.params.endpoint||'/openrtb2/auction'),data:{id:bidderRequest.auctionId,imp,site:{page:bidderRequest.refererInfo?.page},device:{ua:navigator.userAgent}}};
  },
  interpretResponse(serverResponse,request){
    const body=serverResponse.body||{};
    const bids=[];
    for(const seat of body.seatbid||[]) for(const bid of seat.bid||[]) bids.push({requestId:bid.impid,cpm:bid.price,currency:body.cur||'USD',creativeId:bid.crid,dealId:bid.dealid,netRevenue:true,ttl:300,ad:bid.adm,width:bid.w,height:bid.h,meta:{advertiserDomains:bid.adomain||[]}});
    return bids;
  }
};
registerBidder(spec);
