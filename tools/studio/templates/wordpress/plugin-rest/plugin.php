<?php
/**
 * Plugin Name:       {{NAME}}
 * Description:       {{DESCRIPTION}}
 * Version:           {{VERSION}}
 * Requires at least: 6.4
 * Requires PHP:      7.4
 * Author:            {{AUTHOR}}
 * License:           GPL-2.0-or-later
 * Text Domain:       {{SLUG}}
 * Update URI:        false
 *
 * @package {{CLASS}}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( '{{CONST}}_POST_TYPE', '{{PREFIX}}_item' );

/**
 * A custom post type with its own admin menu, archive and REST support.
 */
function {{PREFIX}}_register_post_type() {
	register_post_type(
		{{CONST}}_POST_TYPE,
		array(
			'labels'       => array(
				'name'          => __( '{{NAME}}', '{{SLUG}}' ),
				'singular_name' => __( 'Item', '{{SLUG}}' ),
				'add_new_item'  => __( 'Add new item', '{{SLUG}}' ),
				'edit_item'     => __( 'Edit item', '{{SLUG}}' ),
			),
			'public'       => true,
			'has_archive'  => true,
			'show_in_rest' => true,
			'menu_icon'    => 'dashicons-list-view',
			'supports'     => array( 'title', 'editor', 'thumbnail', 'excerpt', 'custom-fields' ),
			'rewrite'      => array( 'slug' => '{{SLUG}}' ),
		)
	);
	// a field stored with every item, editable through the REST API and the editor
	register_post_meta(
		{{CONST}}_POST_TYPE,
		'{{PREFIX}}_note',
		array(
			'type'              => 'string',
			'single'            => true,
			'show_in_rest'      => true,
			'sanitize_callback' => 'sanitize_text_field',
			'auth_callback'     => function () {
				return current_user_can( 'edit_posts' );
			},
		)
	);
}
add_action( 'init', '{{PREFIX}}_register_post_type' );

/**
 * The archive address needs the rewrite rules refreshed once.
 */
function {{PREFIX}}_activate() {
	{{PREFIX}}_register_post_type();
	flush_rewrite_rules();
}
register_activation_hook( __FILE__, '{{PREFIX}}_activate' );
register_deactivation_hook( __FILE__, 'flush_rewrite_rules' );

/**
 * Own REST endpoints:
 *   GET  /wp-json/{{SLUG}}/v1/items            public list
 *   POST /wp-json/{{SLUG}}/v1/items            create (signed-in editors only)
 */
function {{PREFIX}}_register_routes() {
	register_rest_route(
		'{{SLUG}}/v1',
		'/items',
		array(
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => '{{PREFIX}}_rest_list',
				'permission_callback' => '__return_true',
				'args'                => array(
					'per_page' => array(
						'type'              => 'integer',
						'default'           => 10,
						'minimum'           => 1,
						'maximum'           => 50,
						'sanitize_callback' => 'absint',
					),
				),
			),
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => '{{PREFIX}}_rest_create',
				'permission_callback' => function () {
					return current_user_can( 'edit_posts' );
				},
				'args'                => array(
					'title' => array(
						'type'              => 'string',
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					),
					'note'  => array(
						'type'              => 'string',
						'default'           => '',
						'sanitize_callback' => 'sanitize_text_field',
					),
				),
			),
		)
	);
}
add_action( 'rest_api_init', '{{PREFIX}}_register_routes' );

/**
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response
 */
function {{PREFIX}}_rest_list( WP_REST_Request $request ) {
	$posts = get_posts(
		array(
			'post_type'   => {{CONST}}_POST_TYPE,
			'post_status' => 'publish',
			'numberposts' => (int) $request['per_page'],
		)
	);
	$items = array();
	foreach ( $posts as $post ) {
		$items[] = array(
			'id'    => $post->ID,
			'title' => get_the_title( $post ),
			'note'  => (string) get_post_meta( $post->ID, '{{PREFIX}}_note', true ),
			'link'  => get_permalink( $post ),
			'date'  => get_post_time( 'c', true, $post ),
		);
	}
	return rest_ensure_response( $items );
}

/**
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function {{PREFIX}}_rest_create( WP_REST_Request $request ) {
	$id = wp_insert_post(
		array(
			'post_type'   => {{CONST}}_POST_TYPE,
			'post_status' => 'publish',
			'post_title'  => $request['title'],
		),
		true
	);
	if ( is_wp_error( $id ) ) {
		return $id;
	}
	update_post_meta( $id, '{{PREFIX}}_note', $request['note'] );
	return new WP_REST_Response( array( 'id' => $id, 'link' => get_permalink( $id ) ), 201 );
}
