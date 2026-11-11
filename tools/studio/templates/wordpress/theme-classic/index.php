<?php
/**
 * The template for everything that has no more specific template
 * (add single.php, page.php, archive.php, 404.php … as the theme grows).
 *
 * @package {{CLASS}}
 */

get_header();

if ( have_posts() ) :
	while ( have_posts() ) :
		the_post();
		?>
		<article id="post-<?php the_ID(); ?>" <?php post_class( 'entry' ); ?>>
			<?php if ( is_singular() ) : ?>
				<h1 class="entry-title"><?php the_title(); ?></h1>
			<?php else : ?>
				<h2 class="entry-title"><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2>
			<?php endif; ?>
			<?php if ( 'post' === get_post_type() ) : ?>
				<p class="entry-meta"><?php echo esc_html( get_the_date() ); ?></p>
			<?php endif; ?>
			<div class="entry-content">
				<?php
				if ( is_singular() ) {
					the_content();
					wp_link_pages();
				} else {
					the_excerpt();
				}
				?>
			</div>
		</article>
		<?php
		if ( is_singular() && ( comments_open() || get_comments_number() ) ) {
			comments_template();
		}
	endwhile;
	the_posts_pagination();
else :
	?>
	<p><?php esc_html_e( 'Nothing here yet.', '{{SLUG}}' ); ?></p>
	<?php
endif;

get_footer();
