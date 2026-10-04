<?php
/**
 * Plugin Name: ADPulse Publisher
 * Description: Verify a WordPress site with ADPulse and render approved ADPulse ad zones.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;

add_action('admin_menu', function(){
  add_options_page('ADPulse','ADPulse','manage_options','adpulse-publisher','adpulse_settings_page');
});
add_action('admin_init', function(){
  register_setting('adpulse_settings','adpulse_verification_token',['sanitize_callback'=>'sanitize_text_field']);
  register_setting('adpulse_settings','adpulse_network_url',['sanitize_callback'=>'esc_url_raw']);
});
add_action('wp_head', function(){
  $token=get_option('adpulse_verification_token','');
  if($token) echo '<meta name="adpulse-site-verification" content="'.esc_attr($token).'">'."\n";
},1);

function adpulse_settings_page(){ ?>
<div class="wrap"><h1>ADPulse Publisher</h1><form method="post" action="options.php">
<?php settings_fields('adpulse_settings'); ?>
<table class="form-table">
<tr><th>ADPulse Network URL</th><td><input class="regular-text" name="adpulse_network_url" value="<?php echo esc_attr(get_option('adpulse_network_url','')); ?>" placeholder="https://ads.example.com"></td></tr>
<tr><th>Verification Token</th><td><input class="regular-text" name="adpulse_verification_token" value="<?php echo esc_attr(get_option('adpulse_verification_token','')); ?>" placeholder="ap_xxxxx"></td></tr>
</table><?php submit_button(); ?></form>
<p>After saving the token, return to ADPulse and choose Meta verification. WordPress will publish the verification tag automatically.</p></div>
<?php }

add_shortcode('adpulse', function($atts){
  $atts=shortcode_atts(['zone'=>''],$atts,'adpulse');
  $zone=sanitize_text_field($atts['zone']);
  $base=rtrim(get_option('adpulse_network_url',''),'/');
  if(!$zone || !$base) return '';
  wp_enqueue_script('adpulse-sdk',$base.'/adpulse.js',[],null,true);
  return '<div class="adpulse-ad" data-zone="'.esc_attr($zone).'"></div>';
});
