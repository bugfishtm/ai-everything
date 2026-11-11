<?php
/**
 * {{NAME}} — theme functions.
 *
 * @package {{CLASS}}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme set-up: what the theme supports, its menus.
 */
function {{PREFIX}}_setup() {
	add_theme_support( 'title-tag' );
	add_theme_support( 'post-thumbnails' );
	add_theme_support( 'automatic-feed-links' );
	add_theme_support( 'html5', array( 'search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script' ) );
	add_theme_support( 'responsive-embeds' );
	register_nav_menus( array( 'primary' => __( 'Main menu', '{{SLUG}}' ) ) );
}
add_action( 'after_setup_theme', '{{PREFIX}}_setup' );

function {{PREFIX}}_assets() {
	wp_enqueue_style( '{{SLUG}}', get_stylesheet_uri(), array(), wp_get_theme()->get( 'Version' ) );
	if ( is_singular() && comments_open() && get_option( 'thread_comments' ) ) {
		wp_enqueue_script( 'comment-reply' );
	}
}
add_action( 'wp_enqueue_scripts', '{{PREFIX}}_assets' );

/**
 * A widget area in the footer.
 */
function {{PREFIX}}_widgets() {
	register_sidebar(
		array(
			'name'          => __( 'Footer', '{{SLUG}}' ),
			'id'            => 'footer',
			'before_widget' => '<section class="widget %2$s">',
			'after_widget'  => '</section>',
			'before_title'  => '<h2 class="widget-title">',
			'after_title'   => '</h2>',
		)
	);
}
add_action( 'widgets_init', '{{PREFIX}}_widgets' );
