<?php
/**
 * Plugin Name: Everything Studio
 * Description: Connects this site to the Studio it runs in: one-click sign-in from the WordPress tab, sensible defaults for the hosting. Installed by the Studio — do not edit (it is rewritten).
 * Version: 1.0.0
 * Author: Everything Studio
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * One-click sign-in: the Studio signs a short-lived, single-use token with the secret in
 * wp-config.php (STUDIO_LOGIN_SECRET) and opens /?studio-login=<token>.
 */
function everything_studio_login() {
	if ( empty( $_GET['studio-login'] ) || ! defined( 'STUDIO_LOGIN_SECRET' ) || strlen( STUDIO_LOGIN_SECRET ) < 24 ) {
		return;
	}
	$token = (string) wp_unslash( $_GET['studio-login'] );
	$parts = explode( '.', $token );
	$fail  = function () {
		wp_die( esc_html__( 'This sign-in link is not valid anymore. Open the site again from the Studio.' ), '', array( 'response' => 403 ) );
	};
	if ( 2 !== count( $parts ) ) {
		$fail();
	}
	$expected = rtrim( strtr( base64_encode( hash_hmac( 'sha256', $parts[0], STUDIO_LOGIN_SECRET, true ) ), '+/', '-_' ), '=' );
	if ( ! hash_equals( $expected, $parts[1] ) ) {
		$fail();
	}
	$data = json_decode( base64_decode( strtr( $parts[0], '-_', '+/' ) ), true );
	if ( ! is_array( $data ) || empty( $data['u'] ) || empty( $data['e'] ) || empty( $data['n'] ) || time() > (int) $data['e'] ) {
		$fail();
	}
	// single use
	$key = 'studio_login_' . md5( (string) $data['n'] );
	if ( get_transient( $key ) ) {
		$fail();
	}
	set_transient( $key, 1, 10 * MINUTE_IN_SECONDS );
	$user = get_user_by( 'login', (string) $data['u'] );
	if ( ! $user ) {
		$fail();
	}
	wp_clear_auth_cookie();
	wp_set_current_user( $user->ID );
	wp_set_auth_cookie( $user->ID, false, is_ssl() );
	$to = isset( $data['t'] ) && is_string( $data['t'] ) && 0 === strpos( $data['t'], '/' ) && 0 !== strpos( $data['t'], '//' ) ? $data['t'] : '/wp-admin/';
	wp_safe_redirect( home_url( $to ) );
	exit;
}
add_action( 'init', 'everything_studio_login', 1 );

// The Studio runs wp-cron itself and the site cannot call its own public address from inside
// the container: these two Site Health tests would always report a problem that is none.
add_filter(
	'site_status_tests',
	function ( $tests ) {
		unset( $tests['async']['loopback_requests'], $tests['async']['background_updates'] );
		return $tests;
	}
);

// Own plugins and themes (folders in the project) never get "updates" from wordpress.org
// plugins that happen to have the same name.
add_filter(
	'site_transient_update_plugins',
	function ( $value ) {
		if ( is_object( $value ) && ! empty( $value->response ) ) {
			foreach ( array_keys( (array) $value->response ) as $file ) {
				if ( is_link( WP_PLUGIN_DIR . '/' . dirname( $file ) ) ) {
					unset( $value->response[ $file ] );
				}
			}
		}
		return $value;
	}
);
add_filter(
	'site_transient_update_themes',
	function ( $value ) {
		if ( is_object( $value ) && ! empty( $value->response ) ) {
			foreach ( array_keys( (array) $value->response ) as $slug ) {
				if ( is_link( get_theme_root() . '/' . $slug ) ) {
					unset( $value->response[ $slug ] );
				}
			}
		}
		return $value;
	}
);
