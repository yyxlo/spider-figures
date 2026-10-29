import io
import shutil
import tempfile
from pathlib import Path

from django.contrib.auth.models import User
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from PIL import Image

from .models import Family, Figure, Genus, Reference, Species, Structure

TEMP_MEDIA = tempfile.mkdtemp()


def make_image(name="fig.png", size=(1600, 1000), color=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return SimpleUploadedFile(name, buf.getvalue(), content_type="image/png")


@override_settings(MEDIA_ROOT=TEMP_MEDIA)
class BaseTestCase(TestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(TEMP_MEDIA, ignore_errors=True)

    def setUp(self):
        self.user = User.objects.create_user("alice", password="pw-123456")
        self.client.login(username="alice", password="pw-123456")
        self.fam = Family.objects.create(name="Araneidae")
        self.genus = Genus.objects.create(name="Araneus", family=self.fam)
        self.sp = Species.objects.create(genus=self.genus, epithet="ventricosus", author="(L. Koch, 1878)",
                                         common_name="大腹鬼蛛")
        self.sp2 = Species.objects.create(genus=self.genus, epithet="marmoreus", author="Clerck, 1757")
        old_genus = Genus.objects.create(name="Aranea", family=self.fam)
        self.syn = Species.objects.create(genus=old_genus, epithet="ventricosa", valid_species=self.sp)
        self.ref = Reference.objects.create(
            authors="Tanikawa, A.", year="2009", title="Araneidae", journal="The Spiders of Japan",
            pages="420-463",
        )
        self.palp = Structure.objects.get(name="雄觸肢")
        self.epigyne = Structure.objects.get(name="雌外生殖器")

    def add_figure(self, species=None, structure=None, sex="M"):
        return Figure.objects.create(species=species or self.sp, reference=self.ref, image=make_image(),
                                     structure=structure or self.palp, sex=sex, figure_number="Fig. 1",
                                     page="430", uploaded_by=self.user)


class ModelTests(BaseTestCase):
    def test_derivatives_created(self):
        fig = self.add_figure()
        self.assertTrue(fig.thumbnail and fig.medium)
        with Image.open(fig.thumbnail.path) as t:
            self.assertLessEqual(max(t.size), 360)
        with Image.open(fig.medium.path) as m:
            self.assertLessEqual(max(m.size), 1400)

    def test_replacing_image_regenerates_thumbnail(self):
        fig = self.add_figure()
        old_thumb = fig.thumbnail.name
        fig.image = make_image("new.png", color=(0, 0, 255))
        fig.save()
        self.assertNotEqual(fig.thumbnail.name, old_thumb)
        self.assertFalse(Path(TEMP_MEDIA, old_thumb).exists())

    def test_delete_removes_files(self):
        fig = self.add_figure()
        paths = [fig.image.path, fig.thumbnail.path, fig.medium.path]
        fig.delete()
        self.assertFalse(any(Path(p).exists() for p in paths))

    def test_synonym_figures_join_valid_name(self):
        self.add_figure(species=self.syn)
        self.add_figure(species=self.sp)
        self.assertEqual(self.sp.all_figures().count(), 2)
        self.assertEqual(self.syn.all_figures().count(), 2)
        self.assertEqual(self.sp2.all_figures().count(), 0)

    def test_source_label_and_citation(self):
        fig = self.add_figure()
        self.assertEqual(fig.source_label, "Tanikawa 2009: 430, Fig. 1")
        self.assertEqual(self.ref.citation(),
                         "Tanikawa, A. (2009). Araneidae. The Spiders of Japan, 420-463.")
        self.assertIn("@", self.ref.bibtex())

    def test_short_authors(self):
        cases = {
            "Ono, H. & Ogata, K.": "Ono & Ogata",
            "Ono, H., Tanikawa, A. & Ogata, K.": "Ono et al.",
            "Wang, J.-F.": "Wang",
        }
        for authors, expected in cases.items():
            self.assertEqual(Reference(authors=authors).short_authors, expected)


class ViewTests(BaseTestCase):
    def test_login_required(self):
        self.client.logout()
        for name in ["home", "search", "compare", "upload", "reference_list", "taxa_index"]:
            resp = self.client.get(reverse(name))
            self.assertEqual(resp.status_code, 302, name)
            self.assertIn(reverse("login"), resp["Location"])

    def test_media_requires_login(self):
        fig = self.add_figure()
        self.assertEqual(self.client.get(fig.thumbnail.url).status_code, 200)
        self.client.logout()
        self.assertEqual(self.client.get(fig.thumbnail.url).status_code, 302)

    def test_search_genus_and_species(self):
        resp = self.client.get(reverse("search"), {"q": "Araneus ventricosus"})
        self.assertRedirects(resp, self.sp.get_absolute_url())
        resp = self.client.get(reverse("search"), {"q": "Arane"})
        self.assertContains(resp, "Araneus")
        self.assertContains(resp, "Aranea")
        resp = self.client.get(reverse("search"), {"q": "大腹鬼蛛"})
        self.assertRedirects(resp, self.sp.get_absolute_url())
        # abbreviated genus matches both the valid name and the old combination
        resp = self.client.get(reverse("search"), {"q": "A. ventri"})
        self.assertContains(resp, "Araneus ventricosus")
        self.assertContains(resp, "Aranea ventricosa")

    def test_autocomplete(self):
        data = self.client.get(reverse("api_autocomplete"), {"q": "ventric", "kinds": "species"}).json()
        labels = [r["label"] for r in data["results"]]
        self.assertIn("Araneus ventricosus (L. Koch, 1878)", labels)
        data = self.client.get(reverse("api_references"), {"q": "tanikawa 2009"}).json()
        self.assertEqual(data["results"][0]["id"], self.ref.pk)

    def test_pages_render(self):
        fig = self.add_figure()
        self.add_figure(species=self.syn, structure=self.epigyne, sex="F")
        urls = [
            reverse("home"), reverse("taxa_index"), self.fam.get_absolute_url(),
            self.genus.get_absolute_url(), self.sp.get_absolute_url(), self.syn.get_absolute_url(),
            fig.get_absolute_url(), reverse("figure_edit", args=[fig.pk]),
            reverse("reference_list"), self.ref.get_absolute_url(),
            reverse("reference_bibtex", args=[self.ref.pk]), reverse("upload"), reverse("species_create"),
            reverse("compare") + f"?species={self.sp.pk},{self.sp2.pk}",
        ]
        for url in urls:
            self.assertEqual(self.client.get(url).status_code, 200, url)

    def test_species_page_shows_synonym_figures_and_filters(self):
        self.add_figure()
        self.add_figure(species=self.syn, structure=self.epigyne, sex="F")
        resp = self.client.get(self.sp.get_absolute_url())
        self.assertEqual(resp.context["n_figures"], 2)
        resp = self.client.get(self.sp.get_absolute_url(), {"structure": self.epigyne.pk})
        self.assertEqual(resp.context["n_figures"], 1)
        resp = self.client.get(self.sp.get_absolute_url(), {"sex": "M"})
        self.assertEqual(resp.context["n_figures"], 1)

    def test_genus_page_groups_under_valid_name(self):
        self.add_figure(species=self.syn)
        resp = self.client.get(self.genus.get_absolute_url())
        rows = resp.context["rows"]
        self.assertEqual([r["species"] for r in rows], [self.sp])
        # the old genus page shows the figure under its valid name too
        resp = self.client.get(self.syn.genus.get_absolute_url())
        self.assertEqual([r["species"] for r in resp.context["rows"]], [self.sp])

    def test_compare(self):
        self.add_figure()
        self.add_figure(species=self.sp2)
        resp = self.client.get(reverse("compare"),
                               {"species": [f"{self.sp.pk},{self.sp2.pk}", ""], "structure": self.palp.pk})
        cols = resp.context["columns"]
        self.assertEqual([c["species"] for c in cols], [self.sp, self.sp2])
        self.assertEqual(cols[0]["figures"].count(), 1)

    def test_upload_existing_reference_then_batch_edit(self):
        resp = self.client.post(reverse("upload"), {
            "species": self.sp.pk, "reference": self.ref.pk, "structure": self.palp.pk, "sex": "M",
            "view": "", "page": "431", "images": [make_image("a.png"), make_image("b.png")],
        })
        self.assertEqual(Figure.objects.count(), 2)
        self.assertIn(reverse("figure_batch_edit"), resp["Location"])
        figs = list(Figure.objects.order_by("pk"))
        self.assertEqual(figs[0].uploaded_by, self.user)
        data = {"form-TOTAL_FORMS": "2", "form-INITIAL_FORMS": "2"}
        for i, f in enumerate(figs):
            data.update({f"form-{i}-id": f.pk, f"form-{i}-figure_number": f"Fig. {i + 5}",
                         f"form-{i}-page": "431", f"form-{i}-structure": self.epigyne.pk,
                         f"form-{i}-sex": "F", f"form-{i}-view": "ventral", f"form-{i}-notes": ""})
        resp = self.client.post(resp["Location"], data)
        self.assertRedirects(resp, self.sp.get_absolute_url())
        self.assertEqual(Figure.objects.filter(structure=self.epigyne, sex="F").count(), 2)

    def test_upload_with_new_reference(self):
        self.client.post(reverse("upload"), {
            "species": self.sp.pk, "new_reference": "1", "ref-authors": "Yin, C. M.", "ref-year": "1997",
            "ref-title": "Fauna Sinica", "images": [make_image()],
        })
        fig = Figure.objects.get()
        self.assertEqual(fig.reference.authors, "Yin, C. M.")

    def test_hidden_new_reference_fields_not_browser_required(self):
        # Regression: required attributes inside the hidden block blocked every submit
        # that used an existing reference.
        form = self.client.get(reverse("upload")).context["ref_form"]
        for name in ("authors", "year", "title"):
            self.assertNotIn("required", str(form[name]), name)

    def test_new_reference_fields_validated_server_side(self):
        self.client.post(reverse("upload"), {
            "species": self.sp.pk, "new_reference": "1", "images": [make_image()],
        })
        self.assertEqual(Figure.objects.count(), 0)

    def test_upload_requires_reference(self):
        resp = self.client.post(reverse("upload"), {"species": self.sp.pk, "images": [make_image()]})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(Figure.objects.count(), 0)

    def test_upload_rejects_non_image(self):
        bad = SimpleUploadedFile("x.png", b"not an image", content_type="image/png")
        self.client.post(reverse("upload"), {"species": self.sp.pk, "reference": self.ref.pk, "images": [bad]})
        self.assertEqual(Figure.objects.count(), 0)

    def test_delete_permissions(self):
        fig = self.add_figure()
        User.objects.create_user("bob", password="pw-123456")
        self.client.login(username="bob", password="pw-123456")
        self.assertEqual(self.client.post(reverse("figure_delete", args=[fig.pk])).status_code, 403)
        self.client.login(username="alice", password="pw-123456")
        self.client.post(reverse("figure_delete", args=[fig.pk]))
        self.assertFalse(Figure.objects.exists())

    def test_species_create_new_genus_and_synonym(self):
        resp = self.client.post(reverse("species_create"), {
            "genus_name": "epeira", "epithet": "Fusca", "family": self.fam.pk, "valid_species": self.syn.pk,
        })
        sp = Species.objects.get(genus__name="Epeira", epithet="fusca")
        self.assertEqual(sp.valid_species, self.sp)  # pointed at the accepted name, not the synonym
        self.assertIn(f"species={sp.pk}", resp["Location"])

    def test_species_create_requires_family_for_new_genus(self):
        resp = self.client.post(reverse("species_create"), {"genus_name": "Newgenus", "epithet": "x"})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(Genus.objects.filter(name="Newgenus").exists())


class ImportTests(TestCase):
    def write(self, text):
        f = tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8")
        f.write(text)
        f.close()
        self.addCleanup(Path(f.name).unlink)
        return f.name

    def test_import_and_reimport(self):
        path = self.write(
            "family,genus,species,subspecies,author,year,parens,species_lsid\n"
            "Araneidae,Araneus,ventricosus,,L. Koch,1878,1,urn:lsid:nmbe.ch:spidersp:001\n"
            "Araneidae,Araneus,marmoreus,,Clerck,1757,0,urn:lsid:nmbe.ch:spidersp:002\n"
            "Theridiidae,Parasteatoda,tepidariorum,,C. L. Koch,1841,1,\n"
        )
        out = io.StringIO()
        call_command("import_wsc", path, stdout=out)
        self.assertEqual(Species.objects.count(), 3)
        self.assertEqual(Family.objects.count(), 2)
        sp = Species.objects.get(epithet="ventricosus")
        self.assertEqual(sp.author, "(L. Koch, 1878)")
        self.assertEqual(sp.wsc_lsid, "urn:lsid:nmbe.ch:spidersp:001")
        call_command("import_wsc", path, stdout=out)
        self.assertEqual(Species.objects.count(), 3)

    def test_dry_run_and_family_filter(self):
        path = self.write("Family\tGenus\tEpithet\tAuthor\nAraneidae\tAraneus\tx\tA\nLycosidae\tPardosa\ty\tB\n")
        call_command("import_wsc", path, "--dry-run", stdout=io.StringIO())
        self.assertEqual(Species.objects.count(), 0)
        call_command("import_wsc", path, "--family", "Lycosidae", stdout=io.StringIO())
        self.assertEqual(list(Species.objects.values_list("epithet", flat=True)), ["y"])

    def test_darwin_core_filters(self):
        path = self.write(
            "taxonID,family,genus,specificEpithet,scientificNameAuthorship,taxonRank,taxonomicStatus\n"
            "1,Araneidae,Araneus,,Clerck 1757,genus,accepted\n"
            "2,Araneidae,Araneus,diadematus,\"Clerck, 1757\",species,accepted\n"
            "3,Araneidae,Araneus,oldname,X,species,synonym\n"
        )
        call_command("import_wsc", path, stdout=io.StringIO())
        self.assertEqual(list(Species.objects.values_list("epithet", flat=True)), ["diadematus"])

    def test_column_override_and_missing_columns(self):
        from django.core.management.base import CommandError
        path = self.write("fam,gen,sp\nAraneidae,Araneus,x\n")
        with self.assertRaises(CommandError):
            call_command("import_wsc", path, stdout=io.StringIO())
        call_command("import_wsc", path, "--column", "family=fam", "--column", "genus=gen",
                     "--column", "species=sp", stdout=io.StringIO())
        self.assertEqual(Species.objects.count(), 1)


class FuzzySearchTests(BaseTestCase):
    def test_misspelled_name_found_on_postgresql(self):
        from django.db import connection
        if connection.vendor != "postgresql":
            self.skipTest("trigram search needs PostgreSQL")
        resp = self.client.get(reverse("search"), {"q": "Araneus ventricosis"})  # typo
        self.assertTrue(resp.context["found"].get("fuzzy"))
        self.assertIn(self.sp, resp.context["found"]["species"])
